# Maps MCP Connector

Bundled CoWork OS connector for nearby place search, place details, walking routes, and ranked local errand options.

Defaults to OpenStreetMap-backed public endpoints for light development use. Configure `GOOGLE_MAPS_API_KEY` and `MAPS_PROVIDER=google` or `auto` for Google Maps Platform Places/Routes quality.

Environment:

- `MAPS_PROVIDER`: `auto`, `osm`, or `google` (default `auto`)
- `GOOGLE_MAPS_API_KEY`: optional Google Maps Platform key
- `NOMINATIM_BASE_URL`: optional, default `https://nominatim.openstreetmap.org`
- `OSRM_BASE_URL`: optional, default `https://router.project-osrm.org`

Public OSM/Nominatim/OSRM services are not production infrastructure. Use a proxy or self-hosted provider for heavier use.

## Location integration

The agent uses `get_current_location` (a built-in system tool) to obtain desktop coordinates before calling Maps tools. Location access is available on macOS (Core Location), Windows (Windows.Devices.Geolocation), and Linux (GeoClue2). Each request requires explicit one-time user consent through the OS permission dialog.

Typical flow: `get_current_location` -> `maps.rank_nearby_options` or `maps.search_places` with the returned latitude/longitude.
