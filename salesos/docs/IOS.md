# The iPhone app

SalesOS ships a real native iOS app: an Xcode project at `salesos/ios` that can be
run on a device, signed, and submitted to the App Store. It is a Capacitor shell —
a native app whose UI is the SalesOS web client, loaded from inside the app bundle
rather than over the network.

That choice is deliberate. The product is twenty-odd screens of CRM, pipeline,
call console, transcript review and approval queues. Rebuilding those in Swift or
React Native would mean maintaining two implementations of every screen and every
permission rule, and the second one would immediately start drifting from the
first. The shell approach ships the whole product on day one and leaves the door
open to move any individual screen to native later.

## What you need

Building an iOS app requires **macOS with Xcode**. There is no way around this —
Apple's toolchain does not run on Linux or Windows. You also need:

| To do this | You need |
|---|---|
| Run on the simulator | Xcode, free |
| Run on your own iPhone | A free Apple ID (the app expires after 7 days and needs re-installing) |
| TestFlight, or more than a handful of devices | Apple Developer Program, $99/year |
| Ship on the App Store | Apple Developer Program, plus review |

## Build it

```bash
cd salesos
npm install
npm run ios:sync     # builds the web client and copies it into the iOS project
npm run ios:open     # opens the project in Xcode
```

Then in Xcode: select your device or a simulator, set your team under
**Signing & Capabilities**, and press Run.

`npm run ios:sync` is the command to re-run after any change to the web client.
The web assets inside the iOS project are generated and deliberately not
committed — `ios/.gitignore` excludes `App/App/public`, so the project in git
holds the native shell only and the assets always come from a fresh build.

## First launch: pointing the app at a server

The browser build is served by the API itself, so the two share an origin and
nothing needs configuring. The app is different: it is a bundle on a phone with no
idea which SalesOS it belongs to. On first launch it asks for the server address
once, checks it against `/health`, and remembers it.

Two things have to be true for that to work.

**The phone has to reach the server.** Same Wi-Fi and a LAN address like
`192.168.1.20:4000` is the simplest case. iOS App Transport Security normally
blocks plain HTTP, so `Info.plist` sets `NSAllowsLocalNetworking`, which permits
HTTP to private and `.local` addresses only. ATS still applies in full to the
public internet: **a server reached over the internet must use HTTPS.**

A bare host with no port — `192.168.1.20` — is filled in as port 4000, the port
the API defaults to, because leaving the port off is the most common way to get
this wrong and port 80 is never where a self-hosted SalesOS listens. An address
typed with a scheme is taken as given: `https://sales.example.com` is a complete
origin and no port is added, so a reverse-proxied install is not broken by the
convenience. If your server prints a different port on startup, type it.

**The server has to allow the app's origin.** Capacitor loads the bundle from
`capacitor://localhost`, so every API call from the app is cross-origin. That
origin is allowed by default (see `NATIVE_APP_ORIGINS` in `server/src/app.js`) —
which is not a weakening of anything, since every endpoint is authenticated by a
bearer token and a native app is not bound by CORS regardless. If you point the
app at a server behind a proxy that strips or overrides CORS, add the origin to
`WEB_ORIGINS`.

If the setup screen cannot reach the address it echoes the address it actually
tried, which is the address after that normalisation rather than the characters
typed, and names the likeliest causes in order: the server not running, the wrong
port, then the phone being on a different network. CORS is mentioned last because
on a self-hosted app it is the rarest of the four — and because a CORS refusal and
an unreachable host are indistinguishable to the web platform, so the message can
only rank causes, not identify one.

## What is native and what is not

Native: the app shell, the icon, the splash screen, the launch behaviour, App
Store distribution, and the on-device storage of the session.

**Not** native, and worth knowing before you promise it to anyone:

- **CallKit.** Calls can now be placed on the handset (see below), but the app
  does not register with CallKit, so a SalesOS provider call does not appear as a
  system call, and a handset call is a normal carrier call the app has handed off
  to rather than one it controls.
- **Push notifications.** The app uses the same SSE stream as the browser, which
  only delivers while the app is open. Real push needs APNs and a Capacitor push
  plugin.
- **Offline.** The web build has a service worker for its offline shell; the app
  skips it, because its assets are already on the device. Data still requires a
  connection — by design, since a stale lead record presented as current is worse
  than an honest error.
- **Background execution.** Nothing runs while the app is backgrounded.


## Placing calls on the handset

A phone in a salesperson's hand should be able to make a phone call, so the app
can place a call either way, and the first call from a new install asks which:

- **Call with SalesOS** — through the configured telephony provider, exactly as in
  the browser. Recorded, transcribed, analysed; the CRM suggestions are waiting
  when the call ends. This is the product.
- **Call from this iPhone** — the app hands the number to the system dialer and the
  conversation runs over the carrier.

The choice is put to the agent rather than defaulted quietly because the second
option costs the entire AI pipeline. iOS gives an app no access to carrier call
audio, so a handset call has no recording, and therefore no transcript, no
analysis and no extracted CRM updates. The existing machinery reports that
honestly rather than failing: the call ends with `skipReason: 'not_recorded'` and
no transcription job is queued.

Everything else about a handset call is a normal SalesOS call. It is created
through the same `POST /calls`, so it associates to the lead and deal, respects
the do-not-call list, resolves the consent policy, writes the activity log and
marks the lead contacted — which is the point. A call made this way still lands in
the CRM.

One consequence worth understanding: on a handset call the carrier reports nothing
back, so the server never learns whether the callee picked up. The agent is the
only witness, and `endCall` takes them at their word — a reported outcome of
`connected` sets the answered time, and talk time becomes the whole handoff
window, which is the closest available approximation. Provider calls are
unaffected; there the provider observed the call and a claimed outcome does not
override it. Without this, every real conversation an agent had from their own
phone would have been filed as a no-answer.

The mode is remembered per install, and the sidebar shows which one is active and
switches it.

## Verification, honestly

The native path was tested by serving the built bundle from a different origin
than the API and injecting the Capacitor global, which reproduces exactly the
cross-origin situation the shell creates: first launch asks for a server, a bad
address is reported rather than saved, a good one is remembered, sign-in and the
dashboard work cross-origin, every API call targets the server rather than the
bundle, and a relaunch goes straight in.

Handset calling is covered on both sides. The server tests assert that a device
call still associates to the lead, is never recorded whatever the caller asks for,
still refuses a do-not-call contact, still marks the lead contacted, returns an
E.164 number for the dialer, and files a reported conversation as connected rather
than as a no-answer. The browser tests assert that the choice is put to the agent
once, that nothing is dialled before they choose, that the choice is remembered,
and that the sidebar switches it.

The one part that cannot be checked here is the `tel:` handoff itself, which needs
a real handset.

What has **not** been verified is the app running on real iOS. That needs macOS
and a device, so the Xcode build, code signing, ATS behaviour on a physical
network and the WKWebView's own quirks are all unexercised. Treat the first
`npm run ios:sync && npm run ios:open` as the real first test.
