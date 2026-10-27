package main

// Screen message: POST /message {"text":"Dinner in 10 mins","seconds":20}
// Broadcast to every connected TrailRunner screen as {"type":"message",...}.
// Display only: never touches speed, incline or the workout, and (unlike other
// routes) does not count as a "client is here" signal for the dead-man.

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Latest message and run info are also carried in /state so a screen that polls
// (no WebSocket) still receives them. Display data only.
var (
	dispMu    sync.Mutex
	msgID     int
	msgText   string
	msgSecs   float64
	msgExpiry time.Time
	runInfo   map[string]interface{}
	runInfoAt time.Time
)

func dispState() map[string]interface{} {
	dispMu.Lock()
	defer dispMu.Unlock()
	out := map[string]interface{}{}
	if msgID > 0 && time.Now().Before(msgExpiry) {
		out["message"] = map[string]interface{}{"id": msgID, "text": msgText, "seconds": msgSecs, "leftSeconds": msgExpiry.Sub(time.Now()).Seconds()}
	}
	if runInfo != nil && time.Since(runInfoAt) < 15*time.Second {
		out["info"] = runInfo
	}
	return out
}

// handleRunInfo: the TrailRunner screen posts what it alone knows (time left,
// next change) so a phone page can show it. Whitelisted keys, numbers/short text only.
func handleRunInfo(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	var in map[string]interface{}
	if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&in) != nil {
		w.WriteHeader(400)
		return
	}
	clean := map[string]interface{}{}
	for _, k := range []string{"remainingSec", "remainingKm", "nextChangeSec", "pct", "etaSec", "totalSec", "totalKm"} {
		if v, ok := in[k].(float64); ok {
			clean[k] = v
		}
	}
	for _, k := range []string{"name", "stage", "basis"} {
		if v, ok := in[k].(string); ok {
			if rs := []rune(v); len(rs) > 60 {
				v = string(rs[:60])
			}
			clean[k] = v
		}
	}
	dispMu.Lock()
	runInfo, runInfoAt = clean, time.Now()
	dispMu.Unlock()
	w.Write([]byte(`{"ok":true}`))
}

const (
	maxMessageRunes = 140
	minMessageSecs  = 3
	maxMessageSecs  = 120
	defaultMessageS = 20
)

func handleMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Content-Type", "application/json")
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method == "GET" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(messagePage))
		return
	}
	if r.Method != "POST" {
		w.WriteHeader(405)
		w.Write([]byte(`{"ok":false,"error":"POST only"}`))
		return
	}
	var req struct {
		Text    string  `json:"text"`
		Seconds float64 `json:"seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		w.Write([]byte(`{"ok":false,"error":"bad json"}`))
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		w.WriteHeader(400)
		w.Write([]byte(`{"ok":false,"error":"empty text"}`))
		return
	}
	if rs := []rune(text); len(rs) > maxMessageRunes {
		text = string(rs[:maxMessageRunes])
	}
	secs := req.Seconds
	if secs == 0 {
		secs = defaultMessageS
	}
	if secs < minMessageSecs {
		secs = minMessageSecs
	}
	if secs > maxMessageSecs {
		secs = maxMessageSecs
	}
	dispMu.Lock()
	msgID++
	msgText, msgSecs, msgExpiry = text, secs, time.Now().Add(time.Duration(secs*1000)*time.Millisecond)
	id := msgID
	dispMu.Unlock()
	d, _ := json.Marshal(map[string]interface{}{"type": "message", "id": id, "text": text, "seconds": secs})
	broadcastWSData(d)
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "clients": wsCount(), "seconds": secs})
}

// messagePage is served at GET / and GET /message: a read-only phone view of the run
// plus the message box. Plain http from the bridge itself avoids the https-to-http
// mixed-content block. It only reads /state and posts /message.
const messagePage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Treadmill</title>
<style>body{font:18px system-ui;margin:12px;background:#111;color:#eee}h2{margin:4px 0 10px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px}.c{background:#1c1c1c;border-radius:12px;padding:10px}.c b{display:block;font-size:30px}.c small{color:#999}
.w{grid-column:1/3}#st{color:#9c9;margin:6px 0}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:14px;margin:6px 0;border-radius:10px;border:0}
input{background:#222;color:#fff}button{background:#2e7d32;color:#fff;font-weight:700}.q button{background:#333;width:auto;padding:10px 14px;margin:3px}#s{min-height:1.5em;color:#9c9}</style>
<h2>Treadmill <span id=st></span></h2>
<div class=g>
<div class=c><small>Time</small><b id=el>--</b></div><div class=c><small>Time left</small><b id=left>--</b></div>
<div class=c><small>Distance</small><b id=dist>--</b></div><div class=c><small>Distance left</small><b id=dleft>--</b></div>
<div class=c><small>Speed km/h</small><b id=sp>--</b></div><div class=c><small>Incline %</small><b id=inc>--</b></div>
<div class=c><small>Heart rate</small><b id=hr>--</b></div><div class=c><small>Calories</small><b id=cal>--</b></div>
<div class="c w"><small>Next change</small><b id=nx>--</b></div></div>
<h3>Message to the screen</h3>
<input id=t maxlength=140 placeholder="Dinner in 10 mins">
<input id=n type=number value=20 min=3 max=120> <small>seconds on screen</small>
<button id=b>Send</button><div id=s></div>
<div class=q><button>Dinner in 10 mins</button><button>Dinner is ready</button><button>Phone call for you</button><button>Time for a drink</button></div>
<script>
function $(i){return document.getElementById(i)}
function mmss(s){if(s==null||isNaN(s))return '--';s=Math.max(0,Math.round(s));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+':'+('0'+m).slice(-2):m)+':'+('0'+x).slice(-2)}
function poll(){fetch('/state').then(function(r){return r.json()}).then(function(j){var v=j.values||{},w=j.workout||{},i=(j.display||{}).info||{};
$('st').textContent=(w.state||'')+(w.safetyKeyOut?' - SAFETY KEY OUT':'');
$('el').textContent=mmss(+v.Elapsed);$('left').textContent=mmss(i.remainingSec);
$('dist').textContent=(+v.Distance).toFixed(2)+' km';$('dleft').textContent=i.remainingKm!=null?(+i.remainingKm).toFixed(2)+' km':'--';
$('sp').textContent=v.KPH;$('inc').textContent=v.Incline;$('hr').textContent=(+v['Heart Rate']>0)?v['Heart Rate']:'--';$('cal').textContent=v.Calories;
$('nx').textContent=i.nextChangeSec!=null?'in '+mmss(i.nextChangeSec)+(i.stage?' ('+i.stage+')':''):'--'}).catch(function(){$('st').textContent='no link'})}
poll();setInterval(poll,2000);
function send(x){var t=x||$('t').value;if(!t.trim())return;
fetch('/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t,seconds:+$('n').value||20})})
.then(function(r){return r.json()}).then(function(j){$('s').textContent=j.ok?(j.clients?'Sent':'Sent (screen is polling)'):('Error: '+j.error);if(j.ok&&!x)$('t').value=''}).catch(function(){$('s').textContent='Could not reach the treadmill'})}
$('b').onclick=function(){send()};
$('t').onkeydown=function(e){if(e.key=='Enter')send()};
Array.prototype.forEach.call(document.querySelectorAll('.q button'),function(b){b.onclick=function(){send(b.textContent)}});
</script>`

func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(messagePage))
}

// haRunFields are the run-progress values for Home Assistant (MQTT state and GET /ha).
// Values are nil unless the TrailRunner screen has reported within the last 15 s,
// so tiles go "unknown" rather than showing stale numbers.
func haRunFields() map[string]interface{} {
	dispMu.Lock()
	defer dispMu.Unlock()
	f := map[string]interface{}{
		"run_time_left_s": nil, "run_distance_left_km": nil, "run_eta": nil, "run_progress_pct": nil,
		"run_next_change_s": nil, "run_eta_basis": nil, "run_name": nil, "message": nil,
	}
	if runInfo != nil && time.Since(runInfoAt) < 15*time.Second {
		if v, ok := runInfo["remainingSec"]; ok {
			f["run_time_left_s"] = v
		}
		if v, ok := runInfo["remainingKm"]; ok {
			f["run_distance_left_km"] = v
		}
		if v, ok := runInfo["etaSec"].(float64); ok {
			f["run_eta"] = runInfoAt.Add(time.Duration(v * float64(time.Second))).UTC().Format(time.RFC3339)
		}
		if v, ok := runInfo["pct"]; ok {
			f["run_progress_pct"] = v
		}
		if v, ok := runInfo["nextChangeSec"]; ok {
			f["run_next_change_s"] = v
		}
		if v, ok := runInfo["basis"]; ok {
			f["run_eta_basis"] = v
		}
		if v, ok := runInfo["name"]; ok {
			f["run_name"] = v
		}
	}
	if msgID > 0 && time.Now().Before(msgExpiry) {
		f["message"] = msgText
	}
	return f
}

// handleHA: GET /ha returns the same fields plus the live basics as flat JSON, for a
// Home Assistant REST sensor when MQTT is not set up. Read-only.
func handleHA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	mu.RLock()
	out := map[string]interface{}{
		"speed": currentSpeed, "incline": currentIncl, "hr": hrLocked(), "distance_km": currentDist,
		"calories": currentCals, "elapsed_s": currentElapsed, "workout_state": workoutState,
	}
	mu.RUnlock()
	for k, v := range haRunFields() {
		out[k] = v
	}
	json.NewEncoder(w).Encode(out)
}
