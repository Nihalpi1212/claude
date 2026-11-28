#!/usr/bin/env python3
"""Builds the AVIF containers FFmpeg 6.1 cannot write (a grid, irot, an XMP item, an oversized ispe)
around AV1 pictures that FFmpeg (libaom) encoded. Run in the fixture folder:
    python3 make-containers.py
It reads quad-444-gbr-lossless.avif (tile 0) and tile1.avif ... tile3.avif and writes grid-2x2.avif, irot-90-xmp.avif and huge-ispe.avif.
All item data goes in `idat` (iloc construction method 1), unlike FFmpeg's files (method 0, `mdat`)."""
import struct


def boxes(b, off, end):
    while off + 8 <= end:
        size, kind = struct.unpack('>I4s', b[off:off + 8])
        yield kind, off, size
        off += size


def find(b, path, off=0, end=None):
    """The first box at `path` (types), as (start, size)."""
    end = len(b) if end is None else end
    skip = {b'meta': 4}
    for kind, o, size in boxes(b, off, end):
        if kind == path[0]:
            if len(path) == 1:
                return o, size
            return find(b, path[1:], o + 8 + skip.get(kind, 0), o + size)
    raise KeyError(path)


def item_of(path):
    """The av1C, pixi and colr boxes and the AV1 data of a one-item FFmpeg AVIF."""
    b = open(path, 'rb').read()
    o, s = find(b, [b'meta', b'iprp', b'ipco'])
    props = {kind: b[po:po + ps] for kind, po, ps in boxes(b, o + 8, o + s)}
    o, s = find(b, [b'meta', b'iloc'])
    body = b[o + 8:o + s]
    version = body[0]
    sizes = body[4] >> 4, body[4] & 15, body[5] >> 4, (body[5] & 15) if version else 0
    assert struct.unpack('>H', body[6:8])[0] == 1, 'one item'
    p = 8 + 2 + (2 if version else 0) + 2  # item id, construction method, data reference index
    rd = lambda n: (int.from_bytes(body[p:p + n], 'big'), p + n)
    base, p = rd(sizes[2])
    count, p = rd(2)
    data = b''
    for _ in range(count):
        if version and sizes[3]:
            _, p = rd(sizes[3])
        off, p = rd(sizes[0])
        length, p = rd(sizes[1])
        data += b[base + off:base + off + length]
    return props[b'av1C'], props[b'pixi'], props[b'colr'], data


def bx(kind, body):
    return struct.pack('>I', len(body) + 8) + kind + body


def fbx(kind, body, version=0):
    return bx(kind, bytes([version, 0, 0, 0]) + body)


def ispe(w, h):
    return fbx(b'ispe', struct.pack('>II', w, h))


def infe(item, kind, content_type=None):
    body = struct.pack('>HH', item, 0) + kind + b'\0'
    if content_type:
        body += content_type + b'\0'
    return fbx(b'infe', body, version=2)


def build(items, props, refs):
    """items: (id, type, data, 1-based property indices, essential); refs: (type, from, [to])."""
    iinf = struct.pack('>I H', 0, len(items)) + b''.join(infe(i, k, ct) for i, k, _, _, ct in items)
    iloc = bytes([1, 0, 0, 0, 0x44, 0x00]) + struct.pack('>H', len(items))
    ipma = struct.pack('>I I', 0, len(items))
    idat = b''
    for i, _, data, assoc, _ in items:
        iloc += struct.pack('>HHH', i, 1, 0) + struct.pack('>H', 1) + struct.pack('>II', len(idat), len(data))
        idat += data
        ipma += struct.pack('>HB', i, len(assoc)) + bytes(p | 0x80 for p in assoc)
    iref = struct.pack('>I', 0) + b''.join(bx(k, struct.pack('>HH', f, len(to)) + b''.join(struct.pack('>H', t) for t in to)) for k, f, to in refs)
    meta = struct.pack('>I', 0)
    meta += fbx(b'hdlr', b'\0\0\0\0pict' + b'\0' * 13)
    meta += fbx(b'pitm', struct.pack('>H', 1))
    meta += bx(b'iinf', iinf) + bx(b'iloc', iloc)
    if refs:
        meta += bx(b'iref', iref)
    meta += bx(b'iprp', bx(b'ipco', b''.join(props)) + bx(b'ipma', ipma))
    meta += bx(b'idat', idat)
    return bx(b'ftyp', b'avif\0\0\0\0avifmif1miaf') + bx(b'meta', meta)


tiles = [item_of("quad-444-gbr-lossless.avif" if k == 0 else f"tile{k}.avif") for k in range(4)]
av1c, pixi, colr, _ = tiles[0]
assert all(t[0] == av1c for t in tiles), 'the tiles share one av1C'

# A 2 × 2 grid of the four 33 × 17 tiles, cropped by the grid to 64 × 32.
grid = bytes([0, 0, 1, 1]) + struct.pack('>HH', 64, 32)  # version, flags, rows - 1, columns - 1, size
open('grid-2x2.avif', 'wb').write(build(
    [(1, b'grid', grid, [1, 3, 4], None)] + [(2 + k, b'av01', tiles[k][3], [2, 5, 3, 4], None) for k in range(4)],
    [ispe(64, 32), ispe(33, 17), pixi, colr, av1c],
    [(b'dimg', 1, [2, 3, 4, 5])],
))

# Tile 0 turned 90° anticlockwise by `irot`, with an XMP packet described by the image (`cdsc`).
xmp = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       b'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt>'
       b'<rdf:li xml:lang="x-default">Pigment AVIF fixture</rdf:li></rdf:Alt></dc:title>'
       b'</rdf:Description></rdf:RDF></x:xmpmeta>')
open('irot-90-xmp.avif', 'wb').write(build(
    [(1, b'av01', tiles[0][3], [1, 2, 3, 4, 5], None), (2, b'mime', xmp, [], b'application/rdf+xml')],
    [ispe(33, 17), av1c, pixi, colr, bx(b'irot', bytes([1]))],
    [(b'cdsc', 2, [1])],
))

# Tile 0 declaring a 1,048,576 × 1,048,576 picture: refused from the boxes, before any decoding.
open('huge-ispe.avif', 'wb').write(build(
    [(1, b'av01', tiles[0][3], [1, 2, 3, 4], None)],
    [ispe(1 << 20, 1 << 20), av1c, pixi, colr],
    [],
))
