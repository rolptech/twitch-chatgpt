// serato_operations.js
// Stage 2 — Serato "now playing" song awareness for Mind_B0t.
//
// Polls a Serato Live Playlist page and exposes the currently-playing track.
// The /live URL serves the LIVE tracklist during an active set (newest track FIRST);
// when no set is live it serves the playlist ARCHIVE index (no track rows) -> no active set.
//
// Observed live markup (2 Jul 2026), server-rendered, public, no auth, no JS:
//   <div id="playlist_tracklist" class="card no-border playlist-tracklist-view">
//     <div class="playlist-track " id="track_122920976">
//       <div class="playlist-tracktime">1 min ago</div>
//       <div class="playlist-trackname">Tangerine Dream - Reaching Ravenna</div>
//     </div>
//     ... (older tracks below) ...
//   </div>
// The FIRST .playlist-trackname is the current track. Archive pages have no .playlist-track rows.

import https from 'https';

export class SeratoOperations {
    constructor(playlistId, opts = {}) {
        this.playlistId = playlistId;
        this.url = `https://serato.com/playlists/id:${playlistId}/live`;
        this.pollIntervalMs = opts.pollIntervalMs || 30000;      // ~30s
        // Backstop only: if the top track hasn't CHANGED in this long, stop reporting it
        // (covers a tracklist Serato leaves up after a set ends). Generous so long
        // ambient/psybient tracks don't false-trip. Tune after observing real end-of-set.
        this.staleAfterMs = opts.staleAfterMs || 45 * 60 * 1000; // 45 min
        this.currentTrack = null;   // "Artist - Title" or null
        this.currentTime = null;    // raw relative time text, e.g. "1 min ago"
        this.isLiveMarker = false;  // page showed "Live now!"
        this.changedAt = 0;         // ms epoch when currentTrack last changed
        this.lastSeenAt = 0;        // ms epoch of last successful track sighting
        this.lastFetchOk = false;
        this._timer = null;
    }

    start() {
        if (this._timer) return;
        this._poll();                                            // immediate first poll
        this._timer = setInterval(() => this._poll(), this.pollIntervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // User-facing current track, or null if nothing is currently playing.
    nowPlaying() {
        if (!this.currentTrack) return null;
        if (Date.now() - this.changedAt > this.staleAfterMs) return null; // set likely ended
        return this.currentTrack;
    }

    async _poll() {
        try {
            const html = await this._fetch(this.url);
            const parsed = this._parse(html);
            this.lastFetchOk = true;
            this.isLiveMarker = parsed.isLiveMarker;
            if (parsed.track) {
                if (parsed.track !== this.currentTrack) {
                    this.currentTrack = parsed.track;
                    this.changedAt = Date.now();
                }
                this.currentTime = parsed.time;
                this.lastSeenAt = Date.now();
            } else {
                // No track rows -> archive / no active set.
                this.currentTrack = null;
                this.currentTime = null;
            }
        } catch (e) {
            this.lastFetchOk = false;
            console.log(`[serato] poll error: ${e.message}`);
        }
    }

    // Parse the /live HTML. Returns { track, time, isLiveMarker }.
    // track/time are null when there are no track rows (archive / not live).
    _parse(html) {
        const out = { track: null, time: null, isLiveMarker: false };
        if (!html) return out;
        out.isLiveMarker = /Live now!/i.test(html);
        // First .playlist-trackname = current track (newest-first on /live).
        const nameM = html.match(/class="playlist-trackname"[^>]*>([\s\S]*?)<\/div>/i);
        if (!nameM) return out;                                  // no rows -> not live
        out.track = this._clean(nameM[1]);
        const timeM = html.match(/class="playlist-tracktime"[^>]*>([\s\S]*?)<\/div>/i);
        if (timeM) out.time = this._clean(timeM[1]);
        if (!out.track) out.track = null;                        // guard empty
        return out;
    }

    _clean(s) {
        return String(s)
            .replace(/<[^>]*>/g, '')       // strip nested tags
            .replace(/&amp;/g, '&')
            .replace(/&#0?39;|&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _fetch(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: { 'User-Agent': 'Mind_B0t/1.0 (Twitch chat now-playing)' },
                timeout: 10000,
            }, (res) => {
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { data += c; if (data.length > 3_000_000) req.destroy(); });
                res.on('end', () => resolve(data));
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        });
    }
}
