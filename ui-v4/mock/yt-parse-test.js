#!/usr/bin/env node
// Parsing tests for the YouTube link / id / playlist extractor in js/video-view.js (plain Node, no browser).
//   node mock/yt-parse-test.js
'use strict';
var path = require('path');
var YT = require(path.resolve(__dirname, '../js/video-view.js')).YT;
var passed = 0, failed = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function t(input, expect) {
  var got = YT.parse(input);
  var ok = eq(got, expect);
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + JSON.stringify(input) + ' → ' + JSON.stringify(got) + (ok ? '' : '   expected ' + JSON.stringify(expect)));
}
// valid
t('dQw4w9WgXcQ', { type: 'video', id: 'dQw4w9WgXcQ' });
t('  dQw4w9WgXcQ  ', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=42s', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://m.youtube.com/watch?v=dQw4w9WgXcQ#t=10', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://youtu.be/dQw4w9WgXcQ', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://youtu.be/dQw4w9WgXcQ?si=abcdef', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://www.youtube.com/shorts/dQw4w9WgXcQ', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://www.youtube.com/live/dQw4w9WgXcQ', { type: 'video', id: 'dQw4w9WgXcQ' });
t('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=3', { type: 'video', id: 'dQw4w9WgXcQ', list: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' });
t('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', { type: 'playlist', id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' });
t('https://www.youtube-nocookie.com/embed/videoseries?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', { type: 'playlist', id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' });
t('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', { type: 'playlist', id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' });
t('UUxyz1234567890abcdef', { type: 'playlist', id: 'UUxyz1234567890abcdef' });
// invalid
t('', null);
t(null, null);
t('hello world', null);
t('dQw4w9WgXc', null);                       // 10 chars
t('dQw4w9WgXcQQ', null);                     // 12 chars
t('https://vimeo.com/123456', null);
t('https://www.youtube.com/', null);
t('https://www.youtube.com/watch?v=short', null);
t('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', null); // channel pages are not embeddable without an API
t('javascript:alert(1)', null);
// embed URLs
var u = YT.embedUrl({ type: 'video', id: 'dQw4w9WgXcQ' }, false);
var ok1 = /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/.test(u) && /enablejsapi=1/.test(u) && /controls=0/.test(u) && /playsinline=1/.test(u) && !/autoplay/.test(u);
console.log((ok1 ? 'PASS  ' : 'FAIL  ') + 'video embed url: nocookie, enablejsapi, controls=0, no autoplay  ' + u); ok1 ? passed++ : failed++;
var u2 = YT.embedUrl({ type: 'playlist', id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' }, true);
var ok2 = /^https:\/\/www\.youtube-nocookie\.com\/embed\/videoseries\?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf/.test(u2) && /controls=1/.test(u2);
console.log((ok2 ? 'PASS  ' : 'FAIL  ') + 'playlist embed url (videoseries?list=, native controls fallback)  ' + u2); ok2 ? passed++ : failed++;
console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
