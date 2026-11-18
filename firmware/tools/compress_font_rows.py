"""Lossless row prediction of the original resident A1 fallback bitmap.

Only the native32 startup parent uses this asset: its validated full metrics are
already available before bitmap decode. Other build profiles retain the original
packed bitmap. No glyph, metric, mapping or runtime rendering changes.
"""
from pathlib import Path
import argparse
import re
import zlib
from compress_font_asset import bitmap_bytes

ROOT = Path(__file__).resolve().parents[1]


def transform(raw, reverse=False):
    source = (ROOT / 'main/pet_p4_font_cn.c').read_text()
    rows = re.findall(r'\.bitmap_index\s*=\s*(\d+),\s*\.adv_w\s*=\s*\d+,\s*\.box_w\s*=\s*(\d+),\s*\.box_h\s*=\s*(\d+)', source)
    assert len(rows) == 21208
    out = bytearray(raw)
    for offset, width, height in rows:
        offset, width, height = int(offset), int(width), int(height)
        bits = width * height
        assert offset + (bits + 7) // 8 <= len(raw)
        for bit in (range(width, bits) if reverse else range(bits - 1, width - 1, -1)):
            prior = bit - width
            value = (out[offset + prior // 8] >> (7 - prior % 8)) & 1
            out[offset + bit // 8] ^= value << (7 - bit % 8)
    return bytes(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = bitmap_bytes()
    predicted = transform(raw)
    assert transform(predicted, reverse=True) == raw
    asset = ROOT / 'assets/fonts/pet_cn_16_rows.deflate'
    if args.check:
        packed = asset.read_bytes()
    else:
        from zopfli.zlib import compress
        packed = compress(predicted, numiterations=15)
    assert zlib.decompress(packed) == predicted
    fnv = 2166136261
    for byte in raw:
        fnv = ((fnv ^ byte) * 16777619) & 0xffffffff
    header = ('/* Generated lossless predictor; canonical MiSans data remains unchanged. */\n'
              '#pragma once\n'
              f'#define PET_FONT_ROWS_PACKED_BYTES {len(packed)}U\n'
              f'#define PET_FONT_ROWS_ADLER UINT32_C(0x{zlib.adler32(predicted):08x})\n'
              f'#define PET_FONT_ROWS_RESTORED_FNV UINT32_C(0x{fnv:08x})\n')
    target = ROOT / 'main/pet_p4_font_rows_size.h'
    if args.check:
        assert target.read_text() == header, 'Stale row-predicted font asset'
    else:
        asset.write_bytes(packed)
        target.write_text(header)
    print(f'Lossless resident font: {len(raw)} -> {len(packed)} bytes; full bitmap restored exactly')


if __name__ == '__main__':
    main()
