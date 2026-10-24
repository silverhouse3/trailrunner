# Phone page, screen messages and Home Assistant tiles (bridge v5)

Home network only. Nothing here is reachable from the internet.

## Phone page
Open `http://192.168.100.54:4510/` on a phone on the same wifi (TrailRunner running).
Live time, distance, speed, incline, heart rate, calories, time left, distance left, next change,
plus a box to send a message to the treadmill screen (3-120 s, default 20 s, 140 chars).
API: `POST /message {"text":"Dinner in 10 mins","seconds":20}`.

## Home Assistant
Two ways, both read-only:

1. MQTT (if HA has a broker): set `MQTT_BROKER` (and `MQTT_USER`/`MQTT_PASS`) for the bridge. Sensors appear
   automatically under the device "TrailRunner X32i": Run Time Left, Run Distance Left, Run ETA (timestamp),
   Run Progress, Next Change In, Run ETA Basis, Run Name, plus the existing Speed/Distance/Duration etc.
2. REST (no broker): `GET http://192.168.100.54:4510/ha` returns flat JSON, e.g.

```yaml
rest:
  - resource: http://192.168.100.54:4510/ha
    scan_interval: 5
    sensor:
      - name: Treadmill time left
        value_template: "{{ value_json.run_time_left_s }}"
        unit_of_measurement: s
      - name: Treadmill distance left
        value_template: "{{ value_json.run_distance_left_km }}"
        unit_of_measurement: km
      - name: Treadmill ETA
        value_template: "{{ value_json.run_eta }}"
        device_class: timestamp
      - name: Treadmill progress
        value_template: "{{ value_json.run_progress_pct }}"
        unit_of_measurement: "%"
```

ETA basis: programmed workouts and timed programmes use the PLANNED speeds for the rest of the run
(a slow final 2 km is priced at its planned pace). Routes and free distance runs use current pace and
report `run_eta_basis: "pace"`. Values read as unknown if the screen has not reported in 15 s.

NOTE: the older MQTT discovery in the bridge also exposes Set Speed / Set Incline / Start / Stop controls.
Remove those from HA if you do not want automations able to move the belt.
