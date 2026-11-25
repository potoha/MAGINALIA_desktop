"""Build deterministic, small ZIP fixtures for the v3.1 bundle contract."""

from __future__ import annotations

import base64
import hashlib
import json
import stat
import struct
import sys
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Iterable


FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures"
BUNDLE_ID = "capbundle:01ARZ3NDEKTSV4RRFFQ69G5FAV"
CAPTURE_ID = "capture-01"
VALID_CAPTURE_IDS = ["capture-01", "capture-02"]
BOOK_ID = "capture-book-id:日本語"
GET_DATE = "202610120930"
PACKAGE_ID = "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW"
PACKAGE_IDS = [
    "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW",
    "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAX",
    "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAY",
    "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAZ",
]

# A fixed, valid 1x1 JPEG keeps fixture output stable across Pillow/libjpeg versions.
JPEG_BYTES = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////"
    "2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AV//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AV//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IT//2Q=="
)


@dataclass(frozen=True)
class Member:
    name: str
    data: bytes
    external_attr: int | None = None
    compression: int = zipfile.ZIP_STORED


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _zip_bytes(members: Iterable[Member]) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w", allowZip64=False) as archive:
        for member in members:
            info = zipfile.ZipInfo(member.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = member.compression
            info.create_system = 3
            info.external_attr = member.external_attr if member.external_attr is not None else (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, member.data, compress_type=member.compression, compresslevel=9)
    return output.getvalue()


def inner_package(
    *,
    package_id: str = PACKAGE_ID,
    book_id: str = BOOK_ID,
    get_date: str = GET_DATE,
    capture_ids: list[str] | None = None,
    version: int = 3,
    source_hash: str | None = None,
    source_kind: str = "bookwithoutisbn",
    isbn13: str | None = None,
    source_url: str | None = "https://example.org/independent-publication",
    include_source_file: bool = True,
    include_page_image: bool = True,
    extra_members: list[Member] | None = None,
    capture_json_overrides: dict[str, bytes] | None = None,
) -> bytes:
    capture_ids = capture_ids or [CAPTURE_ID]
    digest = hashlib.sha256(JPEG_BYTES).hexdigest() if source_hash is None else source_hash
    source: dict[str, object] = {"kind": source_kind, "title": "ISBNのない本"}
    if isbn13 is not None:
        source["isbn13"] = isbn13
    if source_url is not None:
        source["url"] = source_url
    if include_source_file:
        source["files"] = [
            {
                "path": "images/page-1.jpg",
                "mediaType": "image/jpeg",
                "sha256": digest,
                "originalName": "原本.jpg",
            }
        ]
    manifest = {
        "format": "maginalia-capture-package",
        "version": version,
        "packageId": package_id,
        "createdAt": "2026-10-12T00:00:00Z",
        "source": source,
        "get": {"date": get_date},
        "captureCount": len(capture_ids),
    }
    captures = []
    for index, capture_id in enumerate(capture_ids):
        capture = {
            "id": capture_id,
            "ocrStatus": "pending",
            "bookId": book_id,
            "pageImage": {
                "id": "page-1",
                "path": "images/page-1.jpg",
                "mediaType": "image/jpeg",
                "width": 1,
                "height": 1,
            },
            "selectedRegion": {"left": 0.1, "top": 0.2, "right": 0.9, "bottom": 0.8},
            "pageNumber": index + 1,
            "comment": "テスト用 capture",
            "createdAt": f"2026-10-12T00:0{index + 1}:00Z",
        }
        capture_bytes = (capture_json_overrides or {}).get(capture_id, _json_bytes(capture))
        captures.append(Member(f"captures/{capture_id}.json", capture_bytes))
    members = [Member("manifest.json", _json_bytes(manifest)), *captures]
    if include_page_image:
        members.append(Member("images/page-1.jpg", JPEG_BYTES))
    members.extend(extra_members or [])
    return _zip_bytes(members)


def package_record(
    child: bytes,
    *,
    package_id: str = PACKAGE_ID,
    path: str = "packages/日本語の本.magicap",
    book_id: str = BOOK_ID,
    get_date: str = GET_DATE,
    capture_ids: list[str] | None = None,
    sha256: str | None = None,
) -> dict[str, object]:
    return {
        "packageId": package_id,
        "path": path,
        "sizeBytes": len(child),
        "sha256": hashlib.sha256(child).hexdigest() if sha256 is None else sha256,
        "bookId": book_id,
        "get": {"date": get_date},
        "captureIds": [CAPTURE_ID] if capture_ids is None else capture_ids,
    }


def outer_manifest(packages: list[dict[str, object]] | None = None) -> dict[str, object]:
    child = inner_package(
        package_id=PACKAGE_IDS[0],
        book_id="capture-book-id:isbn-backed",
        capture_ids=VALID_CAPTURE_IDS,
        source_kind="book",
        isbn13="9780306406157",
        source_url=None,
        include_source_file=False,
    )
    return {
        "format": "maginalia-capture-bundle",
        "version": "3.1",
        "bundleId": BUNDLE_ID,
        "createdAt": "2026-10-12T02:30:00Z",
        "packages": [
            package_record(
                child,
                package_id=PACKAGE_IDS[0],
                book_id="capture-book-id:isbn-backed",
                capture_ids=VALID_CAPTURE_IDS,
            )
        ] if packages is None else packages,
    }


def _archive(
    manifest: dict[str, object] | bytes,
    children: dict[str, bytes],
    *,
    extras: list[Member] | None = None,
) -> bytes:
    manifest_bytes = manifest if isinstance(manifest, bytes) else _json_bytes(manifest)
    members = [Member("manifest.json", manifest_bytes)]
    members.extend(Member(path, data) for path, data in children.items())
    members.extend(extras or [])
    return _zip_bytes(members)


def _set_encrypted_flag(data: bytes, entry_name: str) -> bytes:
    result = bytearray(data)
    found_local = False
    found_central = False
    cursor = 0
    while True:
        offset = result.find(b"PK\x03\x04", cursor)
        if offset < 0:
            break
        name_length, extra_length = struct.unpack_from("<HH", result, offset + 26)
        name_start = offset + 30
        current_name = bytes(result[name_start : name_start + name_length]).decode("utf-8")
        if current_name == entry_name:
            flags = struct.unpack_from("<H", result, offset + 6)[0]
            struct.pack_into("<H", result, offset + 6, flags | 0x1)
            found_local = True
        cursor = name_start + name_length + extra_length
    cursor = 0
    while True:
        offset = result.find(b"PK\x01\x02", cursor)
        if offset < 0:
            break
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", result, offset + 28)
        name_start = offset + 46
        current_name = bytes(result[name_start : name_start + name_length]).decode("utf-8")
        if current_name == entry_name:
            flags = struct.unpack_from("<H", result, offset + 8)[0]
            struct.pack_into("<H", result, offset + 8, flags | 0x1)
            found_central = True
        cursor = name_start + name_length + extra_length + comment_length
    if not found_local or not found_central:
        raise ValueError(f"failed to mark ZIP member encrypted: {entry_name}")
    return bytes(result)


def _corrupt_stored_member(data: bytes, entry_name: str) -> bytes:
    result = bytearray(data)
    cursor = 0
    while True:
        offset = result.find(b"PK\x03\x04", cursor)
        if offset < 0:
            raise ValueError(f"ZIP member not found: {entry_name}")
        name_length, extra_length = struct.unpack_from("<HH", result, offset + 26)
        name_start = offset + 30
        current_name = bytes(result[name_start : name_start + name_length]).decode("utf-8")
        data_start = name_start + name_length + extra_length
        if current_name == entry_name:
            result[data_start] ^= 0x01
            return bytes(result)
        cursor = data_start + struct.unpack_from("<I", result, offset + 18)[0]


def _fixtures() -> dict[str, bytes]:
    isbn_child = inner_package(
        package_id=PACKAGE_IDS[0],
        book_id="capture-book-id:isbn-backed",
        get_date=GET_DATE,
        capture_ids=VALID_CAPTURE_IDS,
        source_kind="book",
        isbn13="9780306406157",
        source_url=None,
        include_source_file=False,
    )
    isbn_record = package_record(
        isbn_child,
        package_id=PACKAGE_IDS[0],
        path="packages/ISBN-backed-book.magicap",
        book_id="capture-book-id:isbn-backed",
        get_date=GET_DATE,
        capture_ids=VALID_CAPTURE_IDS,
    )
    later_isbn_child = inner_package(
        package_id=PACKAGE_IDS[1],
        book_id="capture-book-id:isbn-backed",
        get_date="202610130930",
        capture_ids=["capture-03"],
        source_kind="book",
        isbn13="9780306406157",
        source_url=None,
        include_source_file=False,
    )
    later_isbn_record = package_record(
        later_isbn_child,
        package_id=PACKAGE_IDS[1],
        path="packages/ISBN-backed-book-later-date.magicap",
        book_id="capture-book-id:isbn-backed",
        get_date="202610130930",
        capture_ids=["capture-03"],
    )
    isbnless_child = inner_package(
        package_id=PACKAGE_IDS[2],
        book_id=BOOK_ID,
        get_date="202610141010",
        capture_ids=["capture-04"],
        source_kind="bookwithoutisbn",
        source_url="https://example.org/independent-publication",
        include_source_file=True,
    )
    isbnless_record = package_record(
        isbnless_child,
        package_id=PACKAGE_IDS[2],
        path="packages/ISBN-less-日本語.magicap",
        book_id=BOOK_ID,
        get_date="202610141010",
        capture_ids=["capture-04"],
    )
    handwritten_child = inner_package(
        package_id=PACKAGE_IDS[3],
        book_id="capture-book-id:handwritten",
        get_date="202610151200",
        capture_ids=["capture-05"],
        source_kind="Handwritten",
        source_url=None,
        include_source_file=True,
    )
    handwritten_record = package_record(
        handwritten_child,
        package_id=PACKAGE_IDS[3],
        path="packages/Handwritten-notes.magicap",
        book_id="capture-book-id:handwritten",
        get_date="202610151200",
        capture_ids=["capture-05"],
    )
    valid_children = {
        isbn_record["path"]: isbn_child,
        later_isbn_record["path"]: later_isbn_child,
        isbnless_record["path"]: isbnless_child,
        handwritten_record["path"]: handwritten_child,
    }
    valid_record = isbn_record
    valid_child = isbn_child
    valid_records = [isbn_record, later_isbn_record, isbnless_record, handwritten_record]
    valid = _archive(outer_manifest(valid_records), valid_children)

    traversal = _archive(
        outer_manifest([valid_record]),
        {valid_record["path"]: valid_child},
        extras=[Member("../escape.txt", b"blocked")],
    )
    device_record = package_record(valid_child, path="packages/CON.magicap")
    device = _archive(outer_manifest([device_record]), {device_record["path"]: valid_child})
    symlink = _zip_bytes(
        [
            Member("manifest.json", _json_bytes(outer_manifest([valid_record]))),
            Member(
                valid_record["path"],
                valid_child,
                external_attr=(stat.S_IFLNK | 0o777) << 16,
            ),
        ]
    )
    encrypted = _set_encrypted_flag(valid, "manifest.json")

    duplicate_key_manifest = (
        b'{"format":"maginalia-capture-bundle","version":"3.1","version":"3.1",'
        + _json_bytes({key: value for key, value in outer_manifest([valid_record]).items() if key not in {"format", "version"}})[1:]
    )
    duplicate_key = _archive(duplicate_key_manifest, {valid_record["path"]: valid_child})
    nonfinite_manifest = _json_bytes(outer_manifest([valid_record]))[:-1] + b',"unused":NaN}'
    nonfinite = _archive(nonfinite_manifest, {valid_record["path"]: valid_child})

    bad_bundle_hash_record = package_record(valid_child, sha256="0" * 64)
    bad_bundle_hash = _archive(outer_manifest([bad_bundle_hash_record]), {bad_bundle_hash_record["path"]: valid_child})

    bad_inner_child = inner_package(source_hash="0" * 64)
    bad_inner_record = package_record(bad_inner_child)
    bad_inner_source_hash = _archive(outer_manifest([bad_inner_record]), {bad_inner_record["path"]: bad_inner_child})

    duplicate_inner_json_child = inner_package(
        capture_json_overrides={
            CAPTURE_ID: b'{"id":"capture-01","id":"capture-01","ocrStatus":"pending"}'
        }
    )
    duplicate_inner_json_record = package_record(duplicate_inner_json_child)
    duplicate_inner_json = _archive(
        outer_manifest([duplicate_inner_json_record]),
        {duplicate_inner_json_record["path"]: duplicate_inner_json_child},
    )

    bad_crc_child = _corrupt_stored_member(valid_child, "images/page-1.jpg")
    bad_crc_record = package_record(bad_crc_child, package_id=PACKAGE_IDS[0], book_id=valid_record["bookId"], capture_ids=VALID_CAPTURE_IDS)
    bad_child_crc = _archive(outer_manifest([bad_crc_record]), {bad_crc_record["path"]: bad_crc_child})

    old_child = inner_package(version=2)
    old_record = package_record(old_child)
    wrong_inner_version = _archive(outer_manifest([old_record]), {old_record["path"]: old_child})

    wrong_book_record = package_record(valid_child, book_id="different-opaque-id")
    wrong_book_id = _archive(outer_manifest([wrong_book_record]), {wrong_book_record["path"]: valid_child})

    wrong_size_record = package_record(valid_child)
    wrong_size_record["sizeBytes"] = int(wrong_size_record["sizeBytes"]) + 1
    wrong_size = _archive(outer_manifest([wrong_size_record]), {wrong_size_record["path"]: valid_child})

    wrong_package_id_record = package_record(valid_child, package_id=PACKAGE_IDS[1])
    wrong_package_id = _archive(outer_manifest([wrong_package_id_record]), {wrong_package_id_record["path"]: valid_child})

    wrong_date_record = package_record(valid_child, get_date="202610120931")
    wrong_date = _archive(outer_manifest([wrong_date_record]), {wrong_date_record["path"]: valid_child})

    wrong_capture_ids_record = package_record(
        valid_child,
        book_id=valid_record["bookId"],
        capture_ids=["capture-99"],
    )
    wrong_capture_ids = _archive(outer_manifest([wrong_capture_ids_record]), {wrong_capture_ids_record["path"]: valid_child})

    duplicate_capture_child = inner_package(package_id=PACKAGE_IDS[1], book_id="another-book", get_date="202610120931", capture_ids=[CAPTURE_ID])
    duplicate_capture_record = package_record(
        duplicate_capture_child,
        package_id=PACKAGE_IDS[1],
        path="packages/another.magicap",
        book_id="another-book",
        get_date="202610120931",
    )
    duplicate_capture_ids = _archive(
        outer_manifest([valid_record, duplicate_capture_record]),
        {valid_record["path"]: valid_child, duplicate_capture_record["path"]: duplicate_capture_child},
    )

    duplicate_group_child = inner_package(
        package_id=PACKAGE_IDS[1],
        book_id=valid_record["bookId"],
        get_date=valid_record["get"]["date"],
        capture_ids=["capture-03"],
        source_kind="book",
        isbn13="9780306406157",
        source_url=None,
        include_source_file=False,
    )
    duplicate_group_record = package_record(
        duplicate_group_child,
        package_id=PACKAGE_IDS[1],
        path="packages/second.magicap",
        book_id=valid_record["bookId"],
        get_date=valid_record["get"]["date"],
        capture_ids=["capture-03"],
    )
    duplicate_group = _archive(
        outer_manifest([valid_record, duplicate_group_record]),
        {valid_record["path"]: valid_child, duplicate_group_record["path"]: duplicate_group_child},
    )

    missing_child = _archive(outer_manifest([valid_record]), {})
    missing_inner_image_child = inner_package(
        source_kind="Handwritten",
        source_url=None,
        include_source_file=True,
        include_page_image=False,
    )
    missing_inner_image_record = package_record(missing_inner_image_child)
    missing_inner_image = _archive(
        outer_manifest([missing_inner_image_record]),
        {missing_inner_image_record["path"]: missing_inner_image_child},
    )
    unreferenced = _archive(
        outer_manifest([valid_record]),
        {valid_record["path"]: valid_child},
        extras=[Member("extra.txt", b"not declared")],
    )

    composed_path = "packages/café.magicap"
    decomposed_path = "packages/cafe\u0301.magicap"
    alias_child_a = inner_package(package_id=PACKAGE_IDS[1], book_id="a", get_date="202610120931", capture_ids=["capture-03"])
    alias_child_b = inner_package(package_id=PACKAGE_IDS[2], book_id="b", get_date="202610120932", capture_ids=["capture-04"])
    alias_record_a = package_record(alias_child_a, package_id=PACKAGE_IDS[1], path=composed_path, book_id="a", get_date="202610120931", capture_ids=["capture-03"])
    alias_record_b = package_record(alias_child_b, package_id=PACKAGE_IDS[2], path=decomposed_path, book_id="b", get_date="202610120932", capture_ids=["capture-04"])
    path_alias = _archive(
        outer_manifest([alias_record_a, alias_record_b]),
        {composed_path: alias_child_a, decomposed_path: alias_child_b},
    )

    compressed_bomb_metadata = _archive(
        outer_manifest([valid_record]),
        {valid_record["path"]: valid_child},
        extras=[Member("padding.bin", b"0" * 100_000, compression=zipfile.ZIP_DEFLATED)],
    )

    nested_bomb_child = inner_package(
        extra_members=[Member("notes/unused.txt", b"0" * 100_000, compression=zipfile.ZIP_DEFLATED)]
    )
    nested_bomb_record = package_record(nested_bomb_child)
    nested_bomb = _archive(outer_manifest([nested_bomb_record]), {nested_bomb_record["path"]: nested_bomb_child})

    duplicate_package_child = inner_package(
        package_id=PACKAGE_IDS[1],
        book_id="separate-book",
        get_date="202610161200",
        capture_ids=["capture-06"],
        source_kind="book",
        isbn13="9780306406157",
        source_url=None,
        include_source_file=False,
    )
    duplicate_package_record = package_record(
        duplicate_package_child,
        package_id=PACKAGE_IDS[0],
        path="packages/separate-book.magicap",
        book_id="separate-book",
        get_date="202610161200",
        capture_ids=["capture-06"],
    )
    duplicate_package_id = _archive(
        outer_manifest([valid_record, duplicate_package_record]),
        {valid_record["path"]: valid_child, duplicate_package_record["path"]: duplicate_package_child},
    )

    return {
        "magicap-bundle-v3.1.valid.magicap": valid,
        "magicap-bundle-v3.1.invalid-traversal.magicap": traversal,
        "magicap-bundle-v3.1.invalid-device-path.magicap": device,
        "magicap-bundle-v3.1.invalid-symlink.magicap": symlink,
        "magicap-bundle-v3.1.invalid-encrypted.magicap": encrypted,
        "magicap-bundle-v3.1.invalid-duplicate-json-key.magicap": duplicate_key,
        "magicap-bundle-v3.1.invalid-nonfinite-number.magicap": nonfinite,
        "magicap-bundle-v3.1.invalid-outer-hash.magicap": bad_bundle_hash,
        "magicap-bundle-v3.1.invalid-inner-source-hash.magicap": bad_inner_source_hash,
        "magicap-bundle-v3.1.invalid-inner-duplicate-json-key.magicap": duplicate_inner_json,
        "magicap-bundle-v3.1.invalid-child-crc.magicap": bad_child_crc,
        "magicap-bundle-v3.1.invalid-inner-version.magicap": wrong_inner_version,
        "magicap-bundle-v3.1.invalid-book-id.magicap": wrong_book_id,
        "magicap-bundle-v3.1.invalid-size.magicap": wrong_size,
        "magicap-bundle-v3.1.invalid-package-id.magicap": wrong_package_id,
        "magicap-bundle-v3.1.invalid-date.magicap": wrong_date,
        "magicap-bundle-v3.1.invalid-capture-ids.magicap": wrong_capture_ids,
        "magicap-bundle-v3.1.invalid-duplicate-capture-id.magicap": duplicate_capture_ids,
        "magicap-bundle-v3.1.invalid-duplicate-group.magicap": duplicate_group,
        "magicap-bundle-v3.1.invalid-missing-child.magicap": missing_child,
        "magicap-bundle-v3.1.invalid-missing-inner-image.magicap": missing_inner_image,
        "magicap-bundle-v3.1.invalid-unreferenced-entry.magicap": unreferenced,
        "magicap-bundle-v3.1.invalid-path-alias.magicap": path_alias,
        "magicap-bundle-v3.1.invalid-compression-ratio.magicap": compressed_bomb_metadata,
        "magicap-bundle-v3.1.invalid-inner-compression-ratio.magicap": nested_bomb,
        "magicap-bundle-v3.1.invalid-duplicate-package-id.magicap": duplicate_package_id,
    }


def build_fixtures(output_dir: Path = FIXTURE_DIR) -> dict[str, bytes]:
    output_dir.mkdir(parents=True, exist_ok=True)
    generated = _fixtures()
    for name, data in generated.items():
        (output_dir / name).write_bytes(data)
    return generated


if __name__ == "__main__":
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else FIXTURE_DIR
    fixtures = build_fixtures(destination)
    print(f"Wrote {len(fixtures)} deterministic fixtures to {destination}")
