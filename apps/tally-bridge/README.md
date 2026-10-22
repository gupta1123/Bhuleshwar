# Bhuleshwar Local Agent installer

This directory contains the `electron-builder` NSIS release for **Kalika Local
Agent 1.0.0**. It replaces the legacy hand-copied Electron/Inno connector in
place while preserving the installation identity, pairing, encrypted cache and
managed attachments.

The installer is intentionally defensive:

- closes existing `Kalika Tally Connector.exe` processes before installing
- removes the old connector install folder before copying new files
- preserves the existing `%USERPROFILE%\.autodealer-tally-bridge\config.json` pairing during connector updates
- installs one clean Electron runtime under `C:\Autodealer\tally-bridge`
- registers the `bhuleshwar-tally://` protocol for Connect links
- starts the connector after install so the user can see its current status
- includes the native Debit Note export and Purchase source-document TDLs and
  tries to copy both to the TallyPrime folder for easy one-time activation

## Build

From the repo root:

```powershell
npm run installer:tally-bridge
```

The x64 NSIS installer and update metadata are written below:

```text
installer\tally-bridge\output
```

The root build uses Electron Builder and NSIS. The former `.iss` package is
retained only as historical source and is not part of this build.

## Runtime Layout

The installed connector loads an unpacked app folder:

```text
C:\Autodealer\tally-bridge\resources\app
```

The clean payload does not include:

- old `bridge.log` / `bridge.err.log`
- old backup archives
- stale `resources\app.asar`
- stale `resources\app.asar.unpacked`
- nested Electron build folders

This matters because Electron prefers `resources\app.asar` when it exists. A stale archive can bypass the repaired `resources\app` folder and bring back old connector behavior.

## User Flow

1. Run `KalikaTallyConnectorSetup.exe`.
2. The installer closes old connector processes and starts the new connector.
3. Open Kalika and click **Connect** from the Tally page.
4. The connector window should show `Connected to <company name>` once paired and Tally has a company loaded.

### One-time Tally document activation

The installer keeps the canonical TDL at:

```text
C:\Autodealer\tally-bridge\tdl\kalika-native-debit-note-export.tdl
C:\Autodealer\tally-bridge\tdl\kalika-purchase-document-attachment.tdl
```

It also attempts to make a convenience copy in the TallyPrime installation
folder. In TallyPrime, select both TDLs once in `F1: Help > TDL & Add-On`, turn
on **Load selected TDL files on startup**, and restart TallyPrime. The setup is
per TallyPrime installation, not per company or Debit Note.

If the token expires or the connector is paired to an old server, the window shows reconnect-required status instead of silently pretending to be connected.
