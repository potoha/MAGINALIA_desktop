"""Contract-only validator for MAGINALIA Capture Bundle v3.1 test fixtures.

This module is deliberately not installed or imported by the Reviewer runtime.
It validates the outer bundle, then delegates unchanged v3 package validation
to MagicapImporter._validate_and_extract using a temporary staging directory.
It never initializes a Workspace or calls an import/persistence method.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from marginalia_reviewer.db import Workspace
from marginalia_reviewer.importer import (
    MAGICAP_CAPTURE_PATH,
    MAGICAP_SAFE_ID,
    BundleValidationError as InnerBundleValidationError,
    ImportLimits,
    MagicapImporter,
)
from marginalia_reviewer.schema import ContractValidationError, validate_contract


class BundleContractValidationError(ValueError):
    """The outer bundle or one of its child v3 packages is invalid."""


@dataclass(frozen=True)
class BundleLimits:
    max_outer_zip_bytes: int = 512 * 1024 * 1024
    max_shared_expanded_bytes: int = 2 * 1024 * 1024 * 1024
    max_shared_entries: int = 5_000
    max_entry_bytes: int = 256 * 1024 * 1024
    max_compression_ratio: float = 200.0
    max_json_bytes: int = 1024 * 1024


DEFAULT_LIMITS = BundleLimits()
CHUNK_BYTES = 64 * 1024
ALLOWED_ZIP_COMPRESSION_METHODS = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
_CAPTURE_ID = MAGICAP_SAFE_ID
_WINDOWS_DEVICE = re.compile(
    r"^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)",
    re.IGNORECASE,
)


def _fail(message: str) -> None:
    raise BundleContractValidationError(message)


def _reject_constant(value: str) -> None:
    _fail(f"non-finite JSON number is not allowed: {value}")


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def _parse_finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        _fail("non-finite JSON number is not allowed")
    return parsed


def _validate_json_strings(value: Any) -> None:
    if isinstance(value, str):
        try:
            value.encode("utf-8", "strict")
        except UnicodeEncodeError as exc:
            raise BundleContractValidationError("JSON contains an unpaired surrogate") from exc
    elif isinstance(value, list):
        for item in value:
            _validate_json_strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _validate_json_strings(key)
            _validate_json_strings(item)


def _strict_json(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8", "strict")
        if text.startswith("\ufeff"):
            _fail(f"{label} must not start with a UTF-8 byte-order mark")
        parsed = json.loads(
            text,
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_constant,
            parse_float=_parse_finite_float,
        )
        _validate_json_strings(parsed)
    except BundleContractValidationError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise BundleContractValidationError(f"{label} must be strict UTF-8 JSON") from exc
    return parsed


def _safe_member(name: str) -> PurePosixPath:
    if not isinstance(name, str) or not name:
        _fail("ZIP member name must be a non-empty string")
    if "\\" in name or "\x00" in name or name.startswith("/"):
        _fail(f"unsafe ZIP member path: {name!r}")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in name):
        _fail(f"control character in ZIP member path: {name!r}")
    parts = name.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        _fail(f"empty or traversal ZIP path component: {name!r}")
    for part in parts:
        if any(char in part for char in '<>"|?*'):
            _fail(f"Windows-illegal character in ZIP path: {name!r}")
        if ":" in part:
            _fail(f"drive or alternate-stream colon in ZIP path: {name!r}")
        if part.endswith((".", " ")):
            _fail(f"Windows-ambiguous trailing dot or space in ZIP path: {name!r}")
        if _WINDOWS_DEVICE.match(part):
            _fail(f"Windows reserved device component in ZIP path: {name!r}")
        if len(part.encode("utf-16-le", "strict")) // 2 > 255:
            _fail(f"ZIP path component exceeds the portable name limit: {name!r}")
    path = PurePosixPath(*parts)
    if path.is_absolute():
        _fail(f"absolute ZIP member path is not allowed: {name!r}")
    return path


def _alias_keys(name: str) -> tuple[str, str]:
    nfc = unicodedata.normalize("NFC", name).casefold()
    nfkc = unicodedata.normalize("NFKC", name).casefold()
    return nfc, nfkc


def _check_utf8_member_name(info: zipfile.ZipInfo) -> None:
    original = getattr(info, "orig_filename", info.filename)
    if original != info.filename:
        _fail(f"ZIP member name was truncated or contains NUL: {original!r}")
    try:
        original.encode("utf-8", "strict")
    except UnicodeEncodeError as exc:
        raise BundleContractValidationError("ZIP member name is not valid Unicode") from exc
    if not info.flag_bits & 0x800 and any(ord(char) > 0x7F for char in original):
        _fail(f"non-ASCII ZIP member name is not marked UTF-8: {original!r}")


def _validate_member_metadata(info: zipfile.ZipInfo, limits: BundleLimits) -> None:
    _check_utf8_member_name(info)
    if info.compress_type not in ALLOWED_ZIP_COMPRESSION_METHODS:
        _fail(
            f"unsupported ZIP compression method {info.compress_type} for {info.filename!r}; "
            "only STORED and DEFLATED are allowed"
        )
    if info.is_dir():
        _fail(f"directory ZIP entries are not allowed: {info.filename!r}")
    if info.flag_bits & 0x1:
        _fail(f"encrypted ZIP entries are not allowed: {info.filename!r}")
    if info.flag_bits & 0x40:
        _fail(f"strongly encrypted ZIP entries are not allowed: {info.filename!r}")
    mode = info.external_attr >> 16
    mode_type = stat.S_IFMT(mode)
    if mode_type not in {0, stat.S_IFREG}:
        _fail(f"symbolic links and special ZIP entries are not allowed: {info.filename!r}")
    if info.external_attr & 0x400:
        _fail(f"reparse-point ZIP entries are not allowed: {info.filename!r}")
    if info.file_size < 0 or info.file_size > limits.max_entry_bytes:
        _fail(f"ZIP entry exceeds the per-entry size limit: {info.filename!r}")
    if info.file_size and info.compress_size == 0:
        _fail(f"invalid ZIP compression metadata: {info.filename!r}")
    if info.compress_size and info.file_size / info.compress_size > limits.max_compression_ratio:
        _fail(f"ZIP entry exceeds the compression-ratio limit: {info.filename!r}")
    _safe_member(getattr(info, "orig_filename", info.filename))


def _index_entries(archive: zipfile.ZipFile, limits: BundleLimits, label: str) -> tuple[dict[str, zipfile.ZipInfo], int]:
    infos = archive.infolist()
    if not infos:
        _fail(f"{label} contains no ZIP entries")
    by_name: dict[str, zipfile.ZipInfo] = {}
    aliases: set[str] = set()
    total = 0
    for info in infos:
        _validate_member_metadata(info, limits)
        canonical = PurePosixPath(info.filename).as_posix()
        member_aliases = set(_alias_keys(canonical))
        if aliases.intersection(member_aliases):
            _fail(f"duplicate or aliased ZIP member: {info.filename!r}")
        aliases.update(member_aliases)
        by_name[canonical] = info
        total += info.file_size
        if total > limits.max_shared_expanded_bytes:
            _fail(f"{label} exceeds the shared expanded-size limit")
    return by_name, total


def _read_bounded(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    cap: int,
    expected_bytes: int | None = None,
    digest: Any | None = None,
    output: BinaryIO | None = None,
) -> tuple[int, bytes | None]:
    if info.file_size > cap:
        _fail(f"ZIP entry exceeds its bounded-read limit: {info.filename!r}")
    if expected_bytes is not None and info.file_size != expected_bytes:
        _fail(f"ZIP entry size does not match the declared size: {info.filename!r}")
    collected = bytearray() if output is None and digest is None else None
    total = 0
    try:
        with archive.open(info, "r") as source:
            while True:
                chunk = source.read(min(CHUNK_BYTES, cap - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > cap or total > info.file_size:
                    _fail(f"actual ZIP entry bytes exceed the bounded metadata: {info.filename!r}")
                if collected is not None:
                    collected.extend(chunk)
                if digest is not None:
                    digest.update(chunk)
                if output is not None:
                    output.write(chunk)
    except BundleContractValidationError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, EOFError, NotImplementedError) as exc:
        raise BundleContractValidationError(f"could not safely read ZIP entry {info.filename!r}") from exc
    if total != info.file_size:
        _fail(f"actual ZIP entry size differs from central-directory metadata: {info.filename!r}")
    return total, bytes(collected) if collected is not None else None


def _validate_json_entry(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    name: str,
    limits: BundleLimits,
) -> Any:
    info = entries.get(name)
    if info is None:
        _fail(f"required JSON member is missing: {name}")
    if info.file_size > limits.max_json_bytes:
        _fail(f"JSON member exceeds the JSON size limit: {name}")
    _, data = _read_bounded(archive, info, cap=limits.max_json_bytes)
    assert data is not None
    return _strict_json(data, name)


def _validate_date(value: str) -> None:
    try:
        parsed = datetime.strptime(value, "%Y%m%d%H%M")
    except (TypeError, ValueError) as exc:
        raise BundleContractValidationError("get.date must be a real YYYYMMDDHHMM calendar time") from exc
    if parsed.strftime("%Y%m%d%H%M") != value:
        _fail("get.date must be a real YYYYMMDDHHMM calendar time")


def _check_package_path(value: str) -> None:
    path = _safe_member(value)
    if len(path.parts) != 2 or path.parts[0] != "packages" or not path.name.endswith(".magicap"):
        _fail(f"child package path must be packages/<name>.magicap: {value!r}")
    if path.name == ".magicap":
        _fail("child package filename must have a non-empty basename")


def _validate_child(
    outer_archive: zipfile.ZipFile,
    outer_info: zipfile.ZipInfo,
    package: dict[str, Any],
    stage_root: Path,
    importer: MagicapImporter,
    limits: BundleLimits,
    shared_entry_count: int,
    shared_expanded_bytes: int,
) -> tuple[dict[str, Any], list[dict[str, Any]], int, int]:
    child_path = stage_root / f"child-{package['packageId'].split(':', 1)[1]}.magicap"
    digest = hashlib.sha256()
    try:
        with child_path.open("xb") as child_file:
            _read_bounded(
                outer_archive,
                outer_info,
                cap=limits.max_entry_bytes,
                expected_bytes=package["sizeBytes"],
                digest=digest,
                output=child_file,
            )
    except BundleContractValidationError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise BundleContractValidationError(f"could not stage child package {package['path']!r}") from exc
    if digest.hexdigest() != package["sha256"]:
        _fail(f"SHA-256 mismatch for child package: {package['path']}")

    child_stage = stage_root / f"validated-{package['packageId'].split(':', 1)[1]}"
    child_stage.mkdir()
    extracted: Path | None = None
    try:
        with zipfile.ZipFile(child_path, "r") as child_zip:
            entries, child_expanded_bytes = _index_entries(child_zip, limits, package["path"])
            child_entry_count = len(entries)
            if shared_entry_count + child_entry_count > limits.max_shared_entries:
                _fail("bundle exceeds the shared entry-count limit")
            new_shared_expanded = shared_expanded_bytes + child_expanded_bytes
            if new_shared_expanded > limits.max_shared_expanded_bytes:
                _fail("bundle exceeds the shared expanded-size limit")
            inner_manifest = _validate_json_entry(child_zip, entries, "manifest.json", limits)
            if not isinstance(inner_manifest, dict):
                _fail(f"{package['path']}: inner manifest must be an object")
            if inner_manifest.get("version") != 3:
                _fail(f"{package['path']}: child must be an unchanged .magicap v3 package")
            capture_names = sorted(name for name in entries if MAGICAP_CAPTURE_PATH.fullmatch(name))
            parsed_captures: list[dict[str, Any]] = []
            for name in capture_names:
                value = _validate_json_entry(child_zip, entries, name, limits)
                if not isinstance(value, dict):
                    _fail(f"{package['path']}: {name} must contain an object")
                parsed_captures.append(value)
            # Fully stream every member within the shared limits before asking
            # the unchanged importer validator to perform its staged validation.
            actual_child_bytes = 0
            for info in child_zip.infolist():
                actual_child_bytes += info.file_size
                if shared_expanded_bytes + actual_child_bytes > limits.max_shared_expanded_bytes:
                    _fail("bundle exceeds the shared expanded-size limit")
                _read_bounded(child_zip, info, cap=limits.max_entry_bytes, digest=hashlib.sha256())

        inner_id = inner_manifest.get("packageId")
        inner_date = inner_manifest.get("get", {}).get("date") if isinstance(inner_manifest.get("get"), dict) else None
        outer_date = package["get"]["date"]
        if inner_id != package["packageId"]:
            _fail(f"{package['path']}: outer and inner packageId differ")
        if inner_date != outer_date:
            _fail(f"{package['path']}: outer and inner get.date differ")
        _validate_date(outer_date)
        if len(parsed_captures) != inner_manifest.get("captureCount"):
            _fail(f"{package['path']}: inner captureCount does not match capture records")
        capture_ids: list[str] = []
        for capture in parsed_captures:
            capture_id = capture.get("id")
            if not isinstance(capture_id, str) or not _CAPTURE_ID.fullmatch(capture_id):
                _fail(f"{package['path']}: capture id is unsafe or missing")
            capture_ids.append(capture_id)
            if capture.get("bookId") != package["bookId"]:
                _fail(f"{package['path']}: outer bookId does not exactly match every capture")
        if len(set(capture_ids)) != len(capture_ids):
            _fail(f"{package['path']}: duplicate capture ID in child package")
        if set(capture_ids) != set(package["captureIds"]):
            _fail(f"{package['path']}: outer captureIds do not exactly match child capture IDs")
        if not capture_ids:
            _fail(f"{package['path']}: a bundle child must contain at least one capture")

        inner_manifest_read = importer._read_manifest(child_path)
        extracted = child_stage / "inner"
        inner_manifest_checked, captures_checked = importer._validate_and_extract(
            child_path, extracted, inner_manifest_read
        )
        if inner_manifest_checked != inner_manifest:
            _fail(f"{package['path']}: inner manifest changed during validation")
        if {item["id"] for item in captures_checked} != set(package["captureIds"]):
            _fail(f"{package['path']}: validated inner capture IDs differ from outer manifest")
        return inner_manifest, captures_checked, child_entry_count, child_expanded_bytes
    except (InnerBundleValidationError, ContractValidationError) as exc:
        raise BundleContractValidationError(f"{package['path']}: invalid inner v3 package: {exc}") from exc
    finally:
        if extracted is not None:
            shutil.rmtree(extracted, ignore_errors=True)


def validate_bundle(path: Path, *, source_name: str | None = None, limits: BundleLimits = DEFAULT_LIMITS) -> dict[str, Any]:
    """Validate a complete bundle and every nested v3 ZIP without persistence."""
    name = source_name or path.name
    lower_name = name.casefold()
    if not (lower_name.endswith(".magicap") or lower_name.endswith(".magicap.zip")):
        _fail("Capture Bundles must use .magicap or .magicap.zip")
    if path.stat().st_size > limits.max_outer_zip_bytes:
        _fail("outer ZIP exceeds the compressed-size limit")
    try:
        with zipfile.ZipFile(path, "r") as outer:
            entries, outer_expanded_bytes = _index_entries(outer, limits, "outer bundle")
            if len(entries) > limits.max_shared_entries:
                _fail("bundle exceeds the shared entry-count limit")
            raw_manifest = _validate_json_entry(outer, entries, "manifest.json", limits)
            if not isinstance(raw_manifest, dict):
                _fail("root manifest must be an object")
            try:
                validate_contract(raw_manifest, "magicap-bundle-v3.1-manifest.schema.json")
            except ContractValidationError as exc:
                raise BundleContractValidationError(str(exc)) from exc
            packages = raw_manifest["packages"]
            declared_paths: set[str] = {"manifest.json"}
            seen_package_ids: set[str] = set()
            seen_paths: set[str] = set()
            seen_group_keys: set[tuple[str, str]] = set()
            seen_capture_ids: set[str] = set()
            for package in packages:
                _check_package_path(package["path"])
                path_key = unicodedata.normalize("NFC", package["path"]).casefold()
                if path_key in seen_paths:
                    _fail(f"duplicate or aliased child package path: {package['path']!r}")
                seen_paths.add(path_key)
                if package["packageId"] in seen_package_ids:
                    _fail(f"duplicate child packageId: {package['packageId']}")
                seen_package_ids.add(package["packageId"])
                group = (package["bookId"], package["get"]["date"])
                if group in seen_group_keys:
                    _fail("duplicate exact (bookId, get.date) group")
                seen_group_keys.add(group)
                for capture_id in package["captureIds"]:
                    if capture_id in seen_capture_ids:
                        _fail(f"duplicate capture ID across bundle: {capture_id}")
                    seen_capture_ids.add(capture_id)
                declared_paths.add(package["path"])
            if set(entries) != declared_paths:
                unexpected = sorted(set(entries) - declared_paths)
                missing = sorted(declared_paths - set(entries))
                _fail(f"outer ZIP members must match manifest declarations (unexpected={unexpected}, missing={missing})")

            total_entries = len(entries)
            total_expanded = outer_expanded_bytes
            # Workspace is intentionally never initialized; _validate_and_extract
            # only validates and creates files under this temporary staging root.
            with tempfile.TemporaryDirectory(prefix="magicap-bundle-contract-") as temporary:
                stage_root = Path(temporary)
                importer = MagicapImporter(
                    Workspace(stage_root / "unused-reviewer.sqlite3"),
                    stage_root / "unused-imports",
                    ImportLimits(
                        max_zip_bytes=limits.max_entry_bytes,
                        max_uncompressed_bytes=limits.max_shared_expanded_bytes,
                        max_entries=limits.max_shared_entries,
                        max_entry_bytes=limits.max_entry_bytes,
                        max_compression_ratio=limits.max_compression_ratio,
                    ),
                )
                accepted: list[dict[str, Any]] = []
                for index, package in enumerate(packages):
                    child_info = entries[package["path"]]
                    if child_info.file_size > limits.max_entry_bytes:
                        _fail(f"child package exceeds the per-entry limit: {package['path']}")
                    _, captures, child_entries, child_expanded = _validate_child(
                        outer,
                        child_info,
                        package,
                        stage_root,
                        importer,
                        limits,
                        total_entries,
                        total_expanded,
                    )
                    total_entries += child_entries
                    total_expanded += child_expanded
                    if total_entries > limits.max_shared_entries:
                        _fail("bundle exceeds the shared entry-count limit")
                    if total_expanded > limits.max_shared_expanded_bytes:
                        _fail("bundle exceeds the shared expanded-size limit")
                    accepted.append({"packageId": package["packageId"], "captureCount": len(captures)})
                return {"bundleId": raw_manifest["bundleId"], "packages": accepted}
    except BundleContractValidationError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError, EOFError) as exc:
        raise BundleContractValidationError("bundle is not a readable, valid ZIP archive") from exc
