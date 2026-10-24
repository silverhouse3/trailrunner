// Message banner: shows text sent to the bridge's POST /message for a few seconds.
// Display only. pointer-events:none so it can never cover or block STOP; text via textContent.
var ScreenMessage = {
  _timer: null,
  show: function (text, seconds) {
    var el = document.getElementById('screenMsg');
    if (!el) {
      el = document.createElement('div');
      el.id = 'screenMsg';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = String(text || '').slice(0, 140);
    el.classList.add('show');
    clearTimeout(this._timer);
    var s = Math.min(120, Math.max(3, +seconds || 20));
    this._timer = setTimeout(function () { el.classList.remove('show'); }, s * 1000);
  }
};
