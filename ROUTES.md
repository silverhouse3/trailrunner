# 🗺️ Adding New Routes

## Overview

Routes are arrays of GPS waypoints that Leaflet renders as a polyline on the real map.
The runner marker animates between these points as the simulation progresses.

---

## Quick Format

In `index.html`, find `ROUTE_LATLNGS` and replace with your route:

```javascript
const ROUTE_LATLNGS=[
  [52.0401,-1.8598],  // Start: add a comment for reference
  [52.0392,-1.8570],
  // ... more waypoints ...
  [52.0517,-1.7808],  // Finish
];
```

**Guidelines:**
- 15–25 waypoints is ideal for a smooth animation (too many = slow, too few = jumpy)
- More waypoints in complex sections (climbs, turns), fewer on straight flat sections
- Coordinates in decimal degrees: `[latitude, longitude]`

---

## Getting Waypoints from Strava

1. Find your activity on Strava
2. Open the activity page → click **...** → **Export GPX**
3. Open the GPX file (it's XML) and extract `<trkpt lat="..." lon="...">` entries
4. Thin them down to 15–25 representative points

Or use [GPX Viewer](https://gpx.studio) to visualise and pick points interactively.

---

## Getting Waypoints from Garmin Connect

1. Open activity → **Export** → **Export to GPX**
2. Same process as above

---

## From Google Maps

1. Right-click any point on the map → **What's here?**
2. Copy the lat/lng from the info card
3. Repeat along your route

---

## Auto-convert from GPX (Python helper)

```python
import xml.etree.ElementTree as ET

def gpx_to_waypoints(gpx_file, n_points=20):
    tree = ET.parse(gpx_file)
    ns = {'gpx': 'http://www.topografix.com/GPX/1/1'}
    points = tree.findall('.//gpx:trkpt', ns)
    
    # Evenly sample n_points from all track points
    step = max(1, len(points) // n_points)
    sampled = points[::step][:n_points]
    
    result = []
    for p in sampled:
        lat = float(p.attrib['lat'])
        lon = float(p.attrib['lon'])
        result.append(f"  [{lat:.4f},{lon:.4f}],")
    
    return '\n'.join(result)

print(gpx_to_waypoints('my_run.gpx', n_points=18))
```

---

## Also Update

When adding a new route, update these constants in `index.html`:

```javascript
const TOTAL_KM = 8.4;      // ← total route distance in km
const TOTAL_ASCENT = 186;  // ← total ascent in metres
const TOTAL_PTS = 100;     // ← simulation resolution (keep at 100)
```

And the elevation array `EL[]` (100 values from start elevation to finish elevation).
You can generate this from the GPX elevation data using the same Python approach.

---

## Existing Routes

| Route | Distance | Ascent | Notes |
|-------|----------|--------|-------|
| Cotswold Way: Broadway → Chipping Campden | 8.4km | 186m | Default route. Climbs Fish Hill escarpment. |

---

## Testing Your Route

After adding waypoints, open the app and check:
- The route polyline looks correct on the map
- Start (🟢) and finish (🏁) markers are in the right place
- The runner moves smoothly along the route
- Live coordinates in the bottom-left update correctly
