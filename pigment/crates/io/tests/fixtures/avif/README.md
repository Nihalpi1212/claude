# AVIF fixtures (Pigment)

Small AVIF files for `crates/io/tests/it/avif.rs`, which opens them through `photocraft_io::import`, the
path File › Open takes. The decoder is craft-image-codecs' `avif-decode` (craft-video's AV1 decoder),
switched on by photocraft-io's `avif` feature. The AV1 pictures come from an independent encoder,
libaom through FFmpeg 6.1.1 (Ubuntu 6.1.1-3ubuntu5); FFmpeg 6.1 cannot write a grid, `irot` or an XMP
item, so `make-containers.py` builds those containers around FFmpeg's pictures.

## From craft-libs

Copied unchanged from craft-libs `crates/image-codecs/tests/fixtures/avif/` at 18ffc07 (same project
family and licence, MIT OR Apache-2.0); their README gives the commands (libaom through FFmpeg 7.1):

- `quad-source.rgb`: the 33×17 source, raw RGB24 four-colour quadrants.
- `quad-420-bt709.avif`: 8-bit 4:2:0, limited range, BT.709 matrix, odd size.
- `quad-420-bt709.dav1d.yuv`: that file's AV1 picture as libdav1d decodes it, planar 8-bit 4:2:0.
- `quad-444-gbr-lossless.avif`: lossless 8-bit 4:4:4, identity (GBR) matrix, full range. It decodes
  to `quad-source.rgb` exactly. It is also tile 0 of the grid.

## Made here with FFmpeg

`alpha-source.rgba` (the quadrants with alpha falling from 255 at the left to 0 at the right, the top
row opaque), `card-source.gbrp10le` (a 33×17 10-bit card: R = x·1023/32, G = y·1023/16,
B = (31x + 51y) mod 1024, planar G, B, R, little-endian) and `tile1.rgb`…`tile3.rgb` (the quadrant
source with its channels permuted (1, 2, 0), (2, 0, 1) and (2, 1, 0)) were written by a few lines of
Python; only the AVIFs and the two sources the tests compare with are committed.

- `quad-444-alpha-lossless.avif`: lossless 8-bit 4:4:4 GBR colour with a lossless monochrome alpha
  item (`auxl`, `auxC` `urn:mpeg:mpegB:cicp:systems:auxiliary:alpha`):
  `ffmpeg -f rawvideo -pix_fmt rgba -s 33x17 -i alpha-source.rgba -filter_complex "[0:v]format=gbrap,split[c][a];[c]format=gbrp[c2];[a]alphaextract,format=gray[a2]" -map "[c2]" -map "[a2]" -c:v libaom-av1 -crf 0 -still-picture 1 -colorspace:v:0 rgb -color_range pc quad-444-alpha-lossless.avif`
- `card-444-10bit-lossless.avif`: lossless 10-bit 4:4:4 GBR, full range:
  `ffmpeg -f rawvideo -pix_fmt gbrp10le -s 33x17 -i card-source.gbrp10le -c:v libaom-av1 -crf 0 -still-picture 1 -pix_fmt gbrp10le -colorspace rgb -color_range pc card-444-10bit-lossless.avif`
- `tile1.avif`, `tile2.avif`, `tile3.avif`: the permuted quadrants, lossless 8-bit 4:4:4 GBR, the input
  of `make-containers.py`:
  `ffmpeg -f rawvideo -pix_fmt rgb24 -s 33x17 -i tileK.rgb -c:v libaom-av1 -crf 0 -still-picture 1 -pix_fmt gbrp -colorspace rgb -color_range pc tileK.avif`

## Built by `make-containers.py`

`python3 make-containers.py` in this folder takes the AV1 data, `av1C`, `pixi` and `colr` of
`quad-444-gbr-lossless.avif` and `tile1.avif`…`tile3.avif` and writes, with every item's data in `idat`
(`iloc` construction method 1, where FFmpeg's files use method 0 and `mdat`):

- `grid-2x2.avif`: a `grid` item of the four tiles (2 rows, 2 columns, `dimg`), 64×32: the 66×34 of
  the tiles cropped by the grid.
- `irot-90-xmp.avif`: tile 0 with `irot` 1 (90° anticlockwise, so it opens 17×33) and an XMP packet
  in a `mime` item (`application/rdf+xml`) that describes it (`cdsc`); its title is
  "Pigment AVIF fixture".
- `huge-ispe.avif`: tile 0 declaring a 1,048,576×1,048,576 image (`ispe`): refused from the boxes,
  before any picture is decoded.

Checked with a box dump (no MP4Box in the container): the alpha file has the two `av01` items, the
`auxl` reference from item 2 to item 1 and the `auxC`; the others have the boxes listed above.
