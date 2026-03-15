# Home Assistant Integration

TrailRunner Bridge v3.1+ publishes treadmill state to MQTT with Home Assistant auto-discovery. Once connected, your treadmill appears as a device in HA with sensors and controls.

## Prerequisites

- Home Assistant with MQTT integration enabled
- An MQTT broker (Mosquitto, built into HA, or external)
- TrailRunner Bridge v3.1+ running on the treadmill

## Setup

### 1. Configure the MQTT broker address

Set the `MQTT_BROKER` environment variable before starting the bridge:

```bash
export MQTT_BROKER=tcp://192.168.100.1:1883
export MQTT_USER=homeassistant    # optional
export MQTT_PASS=your_password     # optional
/data/local/tmp/trailrunner-bridge
```

Or pass it via the APK's bridge launcher (future update).

The bridge will auto-connect to MQTT and publish discovery configs. If the broker is unavailable, gRPC motor control still works — MQTT is non-blocking.

### 2. Verify in Home Assistant

After starting the bridge, check **Settings → Devices & Services → MQTT → Devices**. You should see:

**TrailRunner X32i** with these entities:

#### Sensors
| Entity | Type | Unit | Description |
|--------|------|------|-------------|
| `sensor.trailrunner_speed` | Speed | km/h | Current belt speed |
| `sensor.trailrunner_incline` | Incline | % | Current incline percentage |
| `sensor.trailrunner_heart_rate` | HR | bpm | Heart rate (from BLE monitor) |
| `sensor.trailrunner_distance` | Distance | km | Distance covered |
| `sensor.trailrunner_calories` | Calories | kcal | Estimated calories burned |
| `sensor.trailrunner_duration` | Duration | s | Workout elapsed time |
| `sensor.trailrunner_workout_state` | State | — | IDLE, RUNNING, PAUSED, etc. |

#### Controls
| Entity | Type | Description |
|--------|------|-------------|
| `number.trailrunner_set_speed` | Number | Set belt speed (0–22 km/h, step 0.5) |
| `number.trailrunner_set_incline` | Number | Set incline (-6% to +40%, step 0.5) |
| `button.trailrunner_start` | Button | Start a workout |
| `button.trailrunner_stop` | Button | Stop the workout |
| `button.trailrunner_pause` | Button | Pause the workout |
| `button.trailrunner_resume` | Button | Resume the workout |

#### Connectivity
| Entity | Type | Description |
|--------|------|-------------|
| `binary_sensor.trailrunner_available` | Connectivity | Bridge online/offline |

## MQTT Topics

```
trailrunner/state          → JSON: {speed, incline, hr, workout_state, ...}
trailrunner/available      → "online" or "offline"
trailrunner/command/speed  ← float (km/h)
trailrunner/command/incline ← float (%)
trailrunner/command/workout ← "start"|"stop"|"pause"|"resume"
```

## Example Automations

### Start morning run with Alexa
```yaml
automation:
  - alias: "Alexa: Start Treadmill"
    trigger:
      - platform: event
        event_type: alexa_actionable_notification
        event_data:
          event_id: start_treadmill
    action:
      - service: button.press
        target:
          entity_id: button.trailrunner_start
      - delay: "00:00:05"
      - service: number.set_value
        target:
          entity_id: number.trailrunner_set_speed
        data:
          value: 5.0
```

### Auto-fan based on speed
```yaml
automation:
  - alias: "Fan speed matches treadmill"
    trigger:
      - platform: state
        entity_id: sensor.trailrunner_speed
    action:
      - service: fan.set_percentage
        target:
          entity_id: fan.gym_fan
        data:
          percentage: >
            {% set speed = states('sensor.trailrunner_speed') | float(0) %}
            {% if speed < 4 %}20
            {% elif speed < 8 %}50
            {% elif speed < 12 %}80
            {% else %}100{% endif %}
```

### Lights change with workout state
```yaml
automation:
  - alias: "Gym lights follow workout"
    trigger:
      - platform: state
        entity_id: sensor.trailrunner_workout_state
    action:
      - choose:
          - conditions:
              - condition: state
                entity_id: sensor.trailrunner_workout_state
                state: "RUNNING"
            sequence:
              - service: light.turn_on
                target:
                  entity_id: light.gym
                data:
                  color_name: blue
                  brightness: 200
          - conditions:
              - condition: state
                entity_id: sensor.trailrunner_workout_state
                state: "PAUSED"
            sequence:
              - service: light.turn_on
                target:
                  entity_id: light.gym
                data:
                  color_name: yellow
                  brightness: 128
          - conditions:
              - condition: state
                entity_id: sensor.trailrunner_workout_state
                state: "IDLE"
            sequence:
              - service: light.turn_on
                target:
                  entity_id: light.gym
                data:
                  color_name: white
                  brightness: 255
```

### Heart rate zone alert
```yaml
automation:
  - alias: "HR Zone 5 Alert"
    trigger:
      - platform: numeric_state
        entity_id: sensor.trailrunner_heart_rate
        above: 170
        for: "00:00:30"
    action:
      - service: notify.mobile_app
        data:
          title: "TrailRunner"
          message: "HR above 170 for 30s — consider slowing down"
      - service: tts.speak
        target:
          entity_id: tts.google_en
        data:
          message: "Heart rate zone 5. Consider reducing speed."
```

### Auto-stop safety timer
```yaml
automation:
  - alias: "Auto-stop after 90 minutes"
    trigger:
      - platform: numeric_state
        entity_id: sensor.trailrunner_duration
        above: 5400
    condition:
      - condition: state
        entity_id: sensor.trailrunner_workout_state
        state: "RUNNING"
    action:
      - service: button.press
        target:
          entity_id: button.trailrunner_pause
      - service: notify.mobile_app
        data:
          title: "TrailRunner Safety"
          message: "Workout auto-paused after 90 minutes"
```

## Alexa Integration

With Home Assistant Cloud (Nabu Casa) or the Alexa Smart Home skill:

1. Expose TrailRunner entities to Alexa
2. Use routines: "Alexa, start my morning run" → HA automation → button.press + set speed/incline

## REST API (No MQTT Required)

The bridge also exposes a REST API on port 4510 for direct integration:

```bash
# Get full state
curl http://TREADMILL_IP:4510/api/state

# Start workout
curl -X POST http://TREADMILL_IP:4510/workout/start

# Set speed
curl -X POST -H "Content-Type: application/json" \
  -d '{"kph": 8.0}' http://TREADMILL_IP:4510/speed

# Set incline
curl -X POST -H "Content-Type: application/json" \
  -d '{"percent": 3.0}' http://TREADMILL_IP:4510/incline

# Health check
curl http://TREADMILL_IP:4510/health
```

## Grafana Dashboard

For long-term metrics, use the HA → InfluxDB → Grafana pipeline:

1. Configure HA to export sensor data to InfluxDB
2. Create Grafana dashboards for:
   - Weekly distance/time trends
   - Speed progression over time
   - Heart rate zone distribution
   - Incline usage patterns
   - Workout frequency heatmap
