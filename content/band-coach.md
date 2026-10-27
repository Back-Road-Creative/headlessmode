---
title: "Band Coach — an adaptive practice coach for 27 instruments"
description: "A free practice coach for 27 instruments: pitch and timing feedback, ear training, theory, song practice and progress tracking in one downloadable file."
date: 2026-09-19
draft: false
tags: ["open-source", "music", "practice", "web-midi"]
---

Band Coach is a single HTML file that coaches you while you practice. [Download it](https://github.com/Back-Road-Creative/band-coach/releases/latest/download/band-coach.html), open it in a browser, and allow the microphone or connect a MIDI keyboard. It is free, needs no account and installs nothing.

## What practice looks like

Pick an instrument and press Start. Band Coach gives you notes or short phrases to play, shows whether each answer was on pitch and on time, and updates a score for that note. The next exercise is the item with the largest need score (low knowledge, a weak move, or not seen lately), so the same results always give the same lesson. Knowledge fades if you stay away, so older material comes back. An energy meter tracks the session and suggests a break.

<img src="/img/band-coach/trainer-keyboard.png" alt="Keyboard trainer at Level 1 (C, D and E): on-screen keyboard, Start button and energy meter" width="1440" height="900" loading="lazy">

Songs are practiced the same way. Open a tune and it is split into graded steps on the instrument you are playing, in Learn, Rehearse or Check mode. A My speed slider slows the song down, and Hear your try plays back what you just played. Progress shows minutes, a practice calendar, a daily goal and a per-instrument breakdown. It counts how many of the last 7 and 28 days you practiced rather than keeping a streak.

## Get it running

1. Download `band-coach.html` from the link above or the Get panel at the top of this page.
2. Open the file in Chrome or Edge. The app's own MIDI message names those two browsers; without Web MIDI it still accepts screen keys and computer keys.
3. Allow the microphone, or connect a MIDI keyboard. Keyboard uses MIDI, on-screen keys or computer keys; Drum kit uses an electronic kit over MIDI, computer keys, clicks on the drawn kit or the microphone; every other instrument listens through the microphone.

Progress is saved in the browser's local storage, so a different browser or profile starts empty. Use "Save a backup" under Settings → Backups and reset to download `band-coach-progress.json`, and "Restore a backup" to load it again; it shows the backup's date before it replaces anything. "Erase all my data" in the same group removes everything Band Coach keeps in the browser. The release I checked (v1.11.0) makes two network requests, both only when you press their button in Settings, and neither sends anything about your playing: "Check for updates" asks the Band Coach website for the latest version number, and "Download model pack" fetches an optional extra download from the same site.

## Instruments

Band Coach v1.11.0 has 27 instruments, each with its own graded levels:

- **Keys and voice:** Keyboard, Voice.
- **Fretted:** Guitar, Bass, 5-string bass, Ukulele, Baritone ukulele, Low-G ukulele, Mandolin, 5-string banjo.
- **Bowed:** Violin, Viola, Cello, Double bass.
- **Wind and brass:** Trumpet (B flat), Trombone, French horn (F), Clarinet (B flat), Alto sax (E flat), Tenor sax (B flat), Flute, Oboe, Descant recorder, Tin whistle (D).
- **Other:** Harmonica, Mallet percussion (bells), Drum kit.

Drum kit has its own trainer. It takes an electronic kit over MIDI, computer keys, a click on the drawn kit, or the microphone. The microphone can only tell kick, snare and hi-hat apart; a MIDI kit names every piece. Eight practice grooves, from a rock beat to sixteenths on the hi-hat, sit alongside the levels.

<img src="/img/band-coach/instrument-picker.png" alt="Band Coach's instrument picker: a button per instrument family, then a Tools row of drills, tuner, theory and a metronome" width="1440" height="900" loading="lazy">

## What it can't hear {#what-it-cant-hear}

Band Coach hears pitch and timing. It cannot see posture, breath, bowing or hand position, so it does not replace a teacher. The trainer follows one note at a time, and the app marks chord listening as experimental. Add a song, in Songs, has a "More than one note at a time" option for audio you transcribe. Microphone use on phones has not been confirmed; the screenshot below only shows that the layout fits a 390 px wide screen.

<img src="/img/band-coach/trainer-phone.png" alt="Band Coach on a 390 px wide phone: the main nav and the instrument picker" width="390" height="844" loading="lazy">

## Instruments, file formats and tools {#instruments-file-formats-and-tools}

**Import:** a score (`.mid`, `.midi`, `.abc`, `.xml`, `.musicxml`, `.mxl`, `.gp`, `.gp5`), an audio file your browser can decode, a teacher's `.bandpack`, or a saved `.json`. Guitar Pro support is limited to `.gp5` (version 5.x) and `.gp` files.

**Export:** open a song and its Export action saves it as MIDI, MusicXML or ABC.

<img src="/img/band-coach/panel-songs.png" alt="Songs: an Add a song button above the song library of built-in tunes" width="1440" height="900" loading="lazy">

**Main nav:** Practice (the trainer), Songs, Progress, Choose an instrument and Settings.

- **Songs:** practice a built-in starter tune, whose Play it on list shows how it fits each instrument, or use Add a song to record a tune or open a score or recording. An open song also has Edit notes and Play along.
- **Progress:** practice calendar, daily goal and results by instrument, once you have logged a session.
- **Settings:** reset an instrument, backups, erase all data, diagnostics, updates and the optional model pack.

**Tools** (a row in the instrument picker): Interval drill, Rhythm reading, Tuner, Capture a melody, Ear training, How to play it, Music theory and Metronome.

<img src="/img/band-coach/panel-history.png" alt="Progress before any practice: no sessions logged yet, a Start your first session button and results by instrument" width="1440" height="900" loading="lazy">

## Documentation

{{< system-docs name="Band Coach" >}}
