# com.ifit.glassos.BluetoothService - recovered definition

Source: static read of `com.ifit.glassos_service` base.apk (pulled read-only with adb, scratch only) - R8 kept the
protobuf-lite generated classes; field names and type codes were decoded from the `RawMessageInfo` strings and the
service-descriptor strings in classes5.dex. Cross-checked against com.ifit.arda (Devices screen) which references the same
classes. NOTHING was called on the live treadmill; wire behaviour is unverified (see "Unverified").

Service name: `com.ifit.glassos.BluetoothService`. Proto package `com.ifit.glassos`, java package `com.ifit.glassos.bluetooth`.

## Methods (names CONFIRMED; request types CONFIRMED from Kotlin signatures; response types INFERRED)
| Method | Request | Response | Streaming |
|---|---|---|---|
| ScanStateChanged | util.Empty | BluetoothScanState | server stream |
| BluetoothServiceStateChanged | Empty | BluetoothServiceState | server stream |
| FoundDevicesChanged | Empty | BluetoothDeviceList | server stream |
| StartScan | StartScanRequest | BluetoothResult | unary |
| StopScan | Empty | BluetoothResult | unary |
| ConnectDevice | BluetoothDevice | BluetoothResult | unary |
| StopConnecting | BluetoothDevice | BluetoothResult | unary |
| ConnectWithMACAddress | MACAddressConnectionRequest | MACAddressConnectionResult | unary |
| DisconnectDevice | BluetoothDevice | BluetoothResult | unary |
| ConnectToHRM | DeviceIdentifierRequest | BluetoothResult | unary |
| ConnectToRing | DeviceIdentifierRequest | BluetoothResult | unary |
| GetPairedDevices | Empty | BluetoothDeviceList | unary |
| BluetoothDeviceBatteryLevelChanged | DeviceStreamRequest | DeviceBatteryLevelResult | server stream |
| BluetoothDeviceConnectionStateChanged | DeviceStreamRequest | DeviceConnectionStateResult | server stream |
| BluetoothDeviceRSSIChanged | DeviceStreamRequest | DeviceRssiResult | server stream |

(Flow-returning Kotlin methods = server streams; suspend = unary. Response mapping by name/semantics; the Kotlin return
types of suspend funs are erased in the dex, hence "inferred".)

## Messages (field names + numbers + types CONFIRMED from info strings; message/enum targets of oneof INFERRED)
```
message BluetoothDevice { string deviceName=1; string macAddress=2; int32 rssi=3; int32 batteryLevel=4;
                          DeviceType deviceType=5; ConnectionState connectionState=6; string pairKey=7; }
message BluetoothDeviceList { repeated BluetoothDevice devices=1; }
message BluetoothServiceState { repeated BluetoothDevice connectedDevices=1; }
message BluetoothScanState { bool scanning=1; }
message BluetoothResult { oneof errorOrSuccess { IFitError error=1; bool success=2; } }   // 2nd arm is a bool (type code 58)
message StartScanRequest { int32 scanTimeoutSeconds=1; repeated DeviceType deviceTypes=2; }   // packed
message MACAddressConnectionRequest { string macAddress=1; DeviceType deviceType=2; }
message MACAddressConnectionResult { oneof emptyOrDevice { Empty empty=1; BluetoothDevice device=2; } }
message DeviceIdentifierRequest { string deviceIdentifier=1; }
message DeviceStreamRequest { string macAddress=1; }
message DeviceBatteryLevelResult { int32 batteryLevel=1; }   // type of single field not re-checked
message DeviceRssiResult { int32 rssi=1; }
message DeviceConnectionStateResult { ConnectionState connectionState=1; }
enum DeviceType { BLE_IFIT_CONSOLE=0; BLE_HEART_RATE=1; BLE_HEADPHONE=2; BLE_OTHER=3; BLE_IFIT_VIRTUAL_CONSOLE=4;
                  BLE_SMART_WATCH=5; ARCX_RING=6; BLE_PHONE_TABLET=7; }       // numbers read from clinit const/4
enum ConnectionState { BLE_DEVICE_CONNECTED=0; BLE_DEVICE_CONNECTING=1; BLE_DEVICE_DISCONNECTED=2; }
```
Field names of the single-field results (battery/rssi/connection) come from the *_FIELD_NUMBER constants and info windows;
they are order-matched, not independently proven.

## Verdict
- List nearby devices: YES - FoundDevicesChanged (stream; take first/latest) ; GetPairedDevices (unary, bonded).
- Start/stop scan: YES - StartScan{scanTimeoutSeconds,deviceTypes}, StopScan; state via ScanStateChanged.
- Connect: YES - ConnectDevice(BluetoothDevice incl. macAddress/deviceType/pairKey) or ConnectWithMACAddress; ConnectToHRM by identifier.
- Disconnect: YES - DisconnectDevice(BluetoothDevice); StopConnecting cancels a pending connect.
- List connected: YES - BluetoothServiceStateChanged stream -> connectedDevices (no unary getter).
- Device type: YES - DeviceType enum (BLE_HEART_RATE=1 for straps).
- Live HR value: NOT from this service; use existing HeartRateService (already in bridge).

## Unverified (needs a real call / real strap)
Response types above; whether streams emit an initial snapshot on subscribe (bridge must time-box a read and fall back);
whether ConnectDevice needs pairKey populated; whether a scan must run with deviceTypes=[BLE_HEART_RATE] to list straps;
error arm contents. Decode scripts: scratchpad dexstr.py/near.py (not in repo).
