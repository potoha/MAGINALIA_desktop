from __future__ import annotations

import sys
import hashlib
import json
from io import BytesIO
import re
import struct
import zipfile
from pathlib import Path

import pytest

REPOSITORY = Path(__file__).resolve().parents[3]
CONTRACTS = REPOSITORY / "sidecars" / "contracts"
TEST_TOOLS = CONTRACTS / "test_tools"
FIXTURES = CONTRACTS / "fixtures"
sys.path.insert(0, str(TEST_TOOLS))

from build_magicap_bundle_fixtures import JPEG_BYTES, build_fixtures  # noqa: E402
from magicap_bundle_validator import (  # noqa: E402
    BundleContractValidationError,
    BundleLimits,
    validate_bundle,
)


def _read_zip_members(source: Path | BytesIO | bytes) -> dict[str, bytes]:
    if isinstance(source, bytes):
        source = BytesIO(source)
    with zipfile.ZipFile(source) as archive:
        return {info.filename: archive.read(info) for info in archive.infolist()}


def _write_zip_members(destination: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)


def _patch_zip_compression_method(data: bytes, entry_name: str, method: int) -> bytes:
    """Patch both ZIP headers so the central and local compression methods agree."""
    result = bytearray(data)
    local_found = False
    cursor = 0
    while True:
        offset = result.find(b"PK\x03\x04", cursor)
        if offset < 0:
            break
        compressed_size = struct.unpack_from("<I", result, offset + 18)[0]
        name_length, extra_length = struct.unpack_from("<HH", result, offset + 26)
        name_start = offset + 30
        current_name = bytes(result[name_start : name_start + name_length]).decode("utf-8")
        data_start = name_start + name_length + extra_length
        if current_name == entry_name:
            struct.pack_into("<H", result, offset + 8, method)
            local_found = True
        cursor = data_start + compressed_size

    central_found = False
    cursor = 0
    while True:
        offset = result.find(b"PK\x01\x02", cursor)
        if offset < 0:
            break
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", result, offset + 28)
        name_start = offset + 46
        current_name = bytes(result[name_start : name_start + name_length]).decode("utf-8")
        if current_name == entry_name:
            struct.pack_into("<H", result, offset + 10, method)
            central_found = True
        cursor = name_start + name_length + extra_length + comment_length

    if not local_found or not central_found:
        raise ValueError(f"failed to patch ZIP compression method: {entry_name}")
    return bytes(result)


def test_valid_fixture_checks_outer_and_unchanged_v3_child_without_persistence() -> None:
    bundle = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    result = validate_bundle(bundle)
    assert result == {
        "bundleId": "capbundle:01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "packages": [
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW", "captureCount": 2},
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAX", "captureCount": 1},
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAY", "captureCount": 1},
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAZ", "captureCount": 1},
        ],
    }
    with zipfile.ZipFile(bundle) as outer:
        manifest = json.loads(outer.read("manifest.json"))
        packages = manifest["packages"]
        assert packages[0]["captureIds"] == ["capture-01", "capture-02"]
        assert packages[0]["bookId"] == packages[1]["bookId"] == "capture-book-id:isbn-backed"
        assert packages[0]["get"]["date"] != packages[1]["get"]["date"]
        child_kinds: list[str] = []
        for package in packages:
            child_bytes = outer.read(package["path"])
            assert len(child_bytes) == package["sizeBytes"]
            assert hashlib.sha256(child_bytes).hexdigest() == package["sha256"]
            with zipfile.ZipFile(BytesIO(child_bytes)) as child:
                inner = json.loads(child.read("manifest.json"))
                child_kinds.append(inner["source"]["kind"])
                assert inner["version"] == 3
                assert inner["packageId"] == package["packageId"]
                assert inner["get"]["date"] == package["get"]["date"]
                captures = [json.loads(child.read(name)) for name in child.namelist() if name.startswith("captures/")]
                assert {capture["id"] for capture in captures} == set(package["captureIds"])
                assert {capture["bookId"] for capture in captures} == {package["bookId"]}
                assert child.read("images/page-1.jpg") == JPEG_BYTES
                for source_file in inner["source"].get("files", []):
                    exact_bytes = child.read(source_file["path"])
                    assert exact_bytes == JPEG_BYTES
                    assert hashlib.sha256(exact_bytes).hexdigest() == source_file["sha256"]
        assert child_kinds == ["book", "book", "bookwithoutisbn", "Handwritten"]


@pytest.mark.parametrize(
    ("fixture", "message"),
    [
        ("invalid-traversal.magicap", "traversal ZIP path component"),
        ("invalid-device-path.magicap", "reserved device"),
        ("invalid-symlink.magicap", "symbolic links and special"),
        ("invalid-encrypted.magicap", "encrypted ZIP entries"),
        ("invalid-duplicate-json-key.magicap", "duplicate JSON object key"),
        ("invalid-nonfinite-number.magicap", "non-finite JSON number"),
        ("invalid-outer-hash.magicap", "SHA-256 mismatch for child package"),
        ("invalid-inner-source-hash.magicap", "SHA-256 mismatch for canonical source file"),
        ("invalid-inner-duplicate-json-key.magicap", "duplicate JSON object key"),
        ("invalid-child-crc.magicap", "could not safely read ZIP entry"),
        ("invalid-inner-version.magicap", "unchanged .magicap v3 package"),
        ("invalid-book-id.magicap", "outer bookId does not exactly match"),
        ("invalid-size.magicap", "size does not match the declared size"),
        ("invalid-package-id.magicap", "outer and inner packageId differ"),
        ("invalid-date.magicap", "outer and inner get.date differ"),
        ("invalid-capture-ids.magicap", "captureIds do not exactly match"),
        ("invalid-duplicate-capture-id.magicap", "duplicate capture ID across bundle"),
        ("invalid-duplicate-group.magicap", "duplicate exact (bookId, get.date) group"),
        ("invalid-duplicate-package-id.magicap", "duplicate child packageId"),
        ("invalid-missing-child.magicap", "missing="),
        ("invalid-missing-inner-image.magicap", "canonical source file is missing"),
        ("invalid-unreferenced-entry.magicap", "must match manifest declarations"),
        ("invalid-path-alias.magicap", "duplicate or aliased ZIP member"),
        ("invalid-compression-ratio.magicap", "compression-ratio limit"),
        ("invalid-inner-compression-ratio.magicap", "compression-ratio limit"),
    ],
)
def test_concrete_invalid_bundle_fixtures_are_rejected(fixture: str, message: str) -> None:
    with pytest.raises(BundleContractValidationError, match=re.escape(message)):
        validate_bundle(FIXTURES / f"magicap-bundle-v3.1.{fixture}")


def test_fixture_builder_reproduces_checked_in_zip_bytes(tmp_path: Path) -> None:
    generated = build_fixtures(tmp_path)
    assert len(generated) == 26
    for name, data in generated.items():
        assert (FIXTURES / name).read_bytes() == data


def test_deep_json_string_validation_is_reported_as_bundle_error(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    members = _read_zip_members(valid)
    nested = b"[" * 998 + b"0" + b"]" * 998
    # Ensure the input is accepted by the JSON parser and reaches string-tree validation.
    json.loads(nested)
    members["manifest.json"] = members["manifest.json"][:-1] + b',"deep":' + nested + b"}"
    malformed = tmp_path / "deep-json.magicap"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="manifest.json must be strict UTF-8 JSON"):
        validate_bundle(malformed)


def test_outer_zip_rejects_windows_illegal_member_characters(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    members = _read_zip_members(valid)
    members["unexpected?.txt"] = b"extra"
    malformed = tmp_path / "outer-illegal-path.magicap"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="Windows-illegal character"):
        validate_bundle(malformed)


def test_inner_zip_rejects_windows_illegal_member_characters(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    members = _read_zip_members(valid)
    outer_manifest = json.loads(members["manifest.json"])
    package = outer_manifest["packages"][0]
    child_members = _read_zip_members(members[package["path"]])
    child_members["unexpected?.txt"] = b"extra"
    child_output = BytesIO()
    with zipfile.ZipFile(child_output, "w", compression=zipfile.ZIP_STORED) as child_zip:
        for name, data in child_members.items():
            child_zip.writestr(name, data)
    child_bytes = child_output.getvalue()
    members[package["path"]] = child_bytes
    package["sizeBytes"] = len(child_bytes)
    package["sha256"] = hashlib.sha256(child_bytes).hexdigest()
    members["manifest.json"] = json.dumps(
        outer_manifest, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    malformed = tmp_path / "inner-illegal-path.magicap"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="Windows-illegal character"):
        validate_bundle(malformed)


@pytest.mark.parametrize(
    "mutation",
    ["missing-required-property", "numeric-version", "draft-format", "draft-marker", "size-alias"],
)
def test_outer_manifest_schema_rejects_missing_wrong_version_and_capture_draft_shape(
    tmp_path: Path, mutation: str
) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    members = _read_zip_members(valid)
    outer_manifest = json.loads(members["manifest.json"])
    if mutation == "missing-required-property":
        outer_manifest.pop("packages")
    elif mutation == "numeric-version":
        outer_manifest["version"] = 3.1
    elif mutation == "draft-format":
        outer_manifest["format"] = "maginalia-capture-bundle-draft"
    elif mutation == "draft-marker":
        outer_manifest["contractStatus"] = "draft"
    else:
        package = outer_manifest["packages"][0]
        package["size"] = package.pop("sizeBytes")
    members["manifest.json"] = json.dumps(
        outer_manifest, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    malformed = tmp_path / f"{mutation}.magicap"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError):
        validate_bundle(malformed)


def test_bundle_budgets_are_shared_across_outer_and_inner_entries() -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    with zipfile.ZipFile(valid) as outer:
        outer_size = sum(info.file_size for info in outer.infolist())
        child_sizes = []
        child_entries = []
        for name in outer.namelist():
            if not name.startswith("packages/"):
                continue
            child = BytesIO(outer.read(name))
            with zipfile.ZipFile(child) as archive:
                child_sizes.append(sum(info.file_size for info in archive.infolist()))
                child_entries.append(len(archive.infolist()))
        expanded_limit = outer_size + sum(child_sizes) - 1
        entry_limit = len(outer.infolist()) + sum(child_entries) - 1
    with pytest.raises(BundleContractValidationError, match="shared expanded-size limit"):
        validate_bundle(valid, limits=BundleLimits(max_shared_expanded_bytes=expanded_limit))
    with pytest.raises(BundleContractValidationError, match="shared entry-count limit"):
        validate_bundle(valid, limits=BundleLimits(max_shared_entries=entry_limit))
    with pytest.raises(BundleContractValidationError, match="JSON size limit"):
        validate_bundle(valid, limits=BundleLimits(max_json_bytes=10))


@pytest.mark.parametrize("suffix", [".magicap", ".magicap.zip"])
def test_manifest_not_shared_filename_suffix_identifies_bundle_version(
    tmp_path: Path, suffix: str
) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    bundle_path = tmp_path / f"bundle{suffix}"
    bundle_path.write_bytes(valid.read_bytes())
    assert validate_bundle(bundle_path)["bundleId"] == "capbundle:01ARZ3NDEKTSV4RRFFQ69G5FAV"

    with zipfile.ZipFile(bundle_path) as outer:
        child_path = json.loads(outer.read("manifest.json"))["packages"][0]["path"]
        standalone_bytes = outer.read(child_path)
    standalone_path = tmp_path / f"standalone{suffix}"
    standalone_path.write_bytes(standalone_bytes)
    with pytest.raises(BundleContractValidationError):
        validate_bundle(standalone_path)


@pytest.mark.parametrize("source_name", ["bundle.magicap.bundle", "bundle.magicap.bundle.zip", "bundle.zip"])
def test_unapproved_bundle_suffixes_are_rejected(source_name: str) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    with pytest.raises(BundleContractValidationError, match="Capture Bundles must use .magicap or .magicap.zip"):
        validate_bundle(valid, source_name=source_name)


def test_outer_zip_rejects_unsupported_compression_method_from_matching_headers(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    patched = _patch_zip_compression_method(valid.read_bytes(), "manifest.json", 99)
    with zipfile.ZipFile(BytesIO(patched)) as archive:
        assert archive.getinfo("manifest.json").compress_type == 99
    malformed = tmp_path / "unsupported-outer-method.magicap"
    malformed.write_bytes(patched)

    with pytest.raises(BundleContractValidationError, match="unsupported ZIP compression method 99"):
        validate_bundle(malformed)


def test_inner_zip_rejects_unsupported_compression_method_from_matching_headers(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap"
    members = _read_zip_members(valid)
    outer_manifest = json.loads(members["manifest.json"])
    package = outer_manifest["packages"][0]
    child = _patch_zip_compression_method(members[package["path"]], "manifest.json", 99)
    with zipfile.ZipFile(BytesIO(child)) as archive:
        assert archive.getinfo("manifest.json").compress_type == 99
    members[package["path"]] = child
    package["sizeBytes"] = len(child)
    package["sha256"] = hashlib.sha256(child).hexdigest()
    members["manifest.json"] = json.dumps(
        outer_manifest, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    malformed = tmp_path / "unsupported-inner-method.magicap"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="unsupported ZIP compression method 99"):
        validate_bundle(malformed)
