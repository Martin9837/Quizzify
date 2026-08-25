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

**The server has to allow the app's origin.** Capacitor loads the bundle from
`capacitor://localhost`, so every API call from the app is cross-origin. That
origin is allowed by default (see `NATIVE_APP_ORIGINS` in `server/src/app.js`) —
which is not a weakening of anything, since every endpoint is authenticated by a
bearer token and a native app is not bound by CORS regardless. If you point the
app at a server behind a proxy that strips or overrides CORS, add the origin to
`WEB_ORIGINS`.

If the setup screen says it cannot reach the address, those are the two things to
check. A CORS refusal and an unreachable host are indistinguishable to the web
platform, so the message names both.

## What is native and what is not

Native: the app shell, the icon, the splash screen, the launch behaviour, App
Store distribution, and the on-device storage of the session.

**Not** native, and worth knowing before you promise it to anyone:

- **Calling.** Click-to-call goes through the configured telephony provider, the
  same as in the browser. It does not hand off to the iPhone's own dialer, and the
  app does not register with CallKit, so an in-progress SalesOS call does not
  appear as a system call. Wiring `tel:` links or CallKit is the most obvious next
  step for a sales app that lives on a phone.
- **Push notifications.** The app uses the same SSE stream as the browser, which
  only delivers while the app is open. Real push needs APNs and a Capacitor push
  plugin.
- **Offline.** The web build has a service worker for its offline shell; the app
  skips it, because its assets are already on the device. Data still requires a
  connection — by design, since a stale lead record presented as current is worse
  than an honest error.
- **Background execution.** Nothing runs while the app is backgrounded.

## Verification, honestly

The native path was tested by serving the built bundle from a different origin
than the API and injecting the Capacitor global, which reproduces exactly the
cross-origin situation the shell creates: first launch asks for a server, a bad
address is reported rather than saved, a good one is remembered, sign-in and the
dashboard work cross-origin, every API call targets the server rather than the
bundle, and a relaunch goes straight in.

What has **not** been verified is the app running on real iOS. That needs macOS
and a device, so the Xcode build, code signing, ATS behaviour on a physical
network and the WKWebView's own quirks are all unexercised. Treat the first
`npm run ios:sync && npm run ios:open` as the real first test.
