# Bundled geographic context

`geo-coastline.ts` derives from Natural Earth's **1:110m coastline**, downloaded
on 2026-10-09 from the project's
[source GeoJSON](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_coastline.geojson).
The downloaded file's SHA-256 is
`851f581ff5ffb844deed8ae1a9ce22e3c4bb3d74fa342cadb5d8e39b41ae7c3c`.

Natural Earth's [terms of use](https://www.naturalearthdata.com/about/terms-of-use/)
place its vector and raster map data in the public domain and permit modification
and redistribution. The application labels this context “Natural Earth”.

We simplified individual polylines using Douglas–Peucker with a 0.4 degree
tolerance and rounded retained coordinates to 0.01 degree. The output contains
1,965 coordinate pairs and uses NaN pairs as polyline separators. It has no
political boundaries or remote tile requests. It is cartographic context, not
navigational data. Equirectangular projection preserves the coordinate frame;
the density layer counts returned aggregate positions per fixed geographic cell,
not original observations, animals, ships, or population.

This small module loads separately from the renderer. Data markers do not wait
for it; coastline geometry is drawn in bounded animation-frame slices.
