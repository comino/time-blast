# coastline.bin — provenance

`coastline.bin` derives from Natural Earth's **1:110m coastline**, downloaded on 2026-10-09
from the project's
[source GeoJSON](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_coastline.geojson)
(SHA-256 of the download:
`851f581ff5ffb844deed8ae1a9ce22e3c4bb3d74fa342cadb5d8e39b41ae7c3c`).

Natural Earth's [terms of use](https://www.naturalearthdata.com/about/terms-of-use/) place its
vector and raster map data in the public domain and permit modification and redistribution.
Label it "Natural Earth" where the basemap is credited.

## Processing

1. (2026-10-09, legacy `src/ui/geo-coastline.ts`) Each polyline simplified with Douglas–Peucker
   at 0.4° tolerance; retained coordinates rounded to 0.01°. Result: 1,965 coordinate pairs in
   121 polylines.
2. (2026-10-10) Re-encoded losslessly from that file into this binary: little-endian `i16`
   pairs `(lon × 100, lat × 100)`, polylines separated by the pair `(-32768, -32768)`.
   2,086 pairs, 8,344 bytes, SHA-256
   `c2d64494cde16c2997a011452bcd289e965da83c27a4173c90c5659013f6f778`. Every value
   round-trips exactly (asserted during conversion).

Conversion (run once, from the repo root, while `src/ui/geo-coastline.ts` existed):

```python
import struct
src = open('src/ui/geo-coastline.ts').read()
body = src[src.index('Float32Array([') + 14: src.rindex('])')]
vals = [float('nan') if t.strip() == 'NaN' else float(t) for t in body.replace('\n', '').split(',') if t.strip()]
out = bytearray()
for lon, lat in zip(vals[0::2], vals[1::2]):
    out += struct.pack('<hh', -32768, -32768) if lon != lon else struct.pack('<hh', round(lon * 100), round(lat * 100))
open('crates/tb-render/src/view/geo/coastline.bin', 'wb').write(out)
```

## Use

`view/geo.rs` decodes it once (`coastline()`), uploads it per result as `[lon, lat]` f32 pairs
(16.7 KB) from the second frame on, and the GPU projects it like the data. It is cartographic
context only: no political boundaries, no tiles, no network requests, not navigational data.
