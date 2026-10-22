---
title: "Band Coach — an adaptive practice coach for 26 instruments"
description: "A free practice coach for 26 instruments: pitch and timing feedback, ear training, theory, song practice and progress tracking in one downloadable file."
date: 2026-09-19
draft: false
tags: ["open-source", "music", "practice", "web-midi"]
---

Band Coach is a single HTML file that coaches you while you practice. [Download it](https://github.com/Back-Road-Creative/band-coach/releases/latest/download/band-coach.html), open it in a browser, and allow the microphone or connect a MIDI keyboard. It is free, needs no account and installs nothing.

## What practice looks like

Pick an instrument and press Start. Band Coach gives you notes or short phrases to play, shows whether each answer was on pitch and on time, and updates a score for that note. The next exercise is the item with the largest need score (low knowledge, a weak move, or not seen lately), so the same results always give the same lesson. Knowledge fades if you stay away, so older material comes back. An energy meter tracks the session and suggests a break.

<img src="/img/band-coach/trainer-keyboard.png" alt="Keyboard trainer at Level 1 (C, D and E): on-screen keyboard, Start button and energy meter" width="1440" height="900" loading="lazy">

Songs are practiced the same way. Open a tune and it is split into graded steps on the instrument you are playing. My progress shows minutes, a practice calendar, a daily goal and a per-instrument breakdown.

## Get it running

1. Download `band-coach.html` from the link above or the Get panel at the top of this page.
2. Open the file in Chrome or Edge. The app's own MIDI message names those two browsers; without Web MIDI it still accepts screen keys and computer keys.
3. Allow the microphone, or connect a MIDI keyboard. Keyboard uses MIDI, on-screen keys or computer keys; every other instrument listens through the microphone.

Progress is saved in the browser's local storage, so a different browser or profile starts empty. Use "Save a backup" in the side rail's "More options" to download `band-coach-progress.json`, and "Restore a backup" to load it again. "Check for updates" in the same menu asks the Band Coach website for the latest version number and sends nothing about your playing; it is the only network request in the release I checked (v1.9.0).

## Instruments

Band Coach v1.9.0 has 26 instruments, each with its own graded levels:

- **Keys and voice:** Keyboard, Voice.
- **Fretted:** Guitar, Bass, 5-string bass, Ukulele, Baritone ukulele, Low-G ukulele, Mandolin, 5-string banjo.
- **Bowed:** Violin, Viola, Cello, Double bass.
- **Wind and brass:** Trumpet (B flat), Trombone, French horn (F), Clarinet (B flat), Alto sax (E flat), Tenor sax (B flat), Flute, Oboe, Descant recorder, Tin whistle (D).
- **Other:** Harmonica, Mallet percussion (bells).

Drums are not in Band Coach; the app points to a separate page, Kit Coach.

<img src="/img/band-coach/instrument-picker.png" alt="Band Coach's instrument picker: one button per instrument family, with More tools and More ways to practise closed below" width="1440" height="900" loading="lazy">

## What it can't hear {#what-it-cant-hear}

Band Coach hears pitch and timing. It cannot see posture, breath, bowing or hand position, so it does not replace a teacher. The trainer follows one note at a time, and the app marks chord listening as experimental. Record a tune has a "More than one note at a time" option for audio you transcribe. Microphone use on phones has not been confirmed; the screenshot below only shows that the layout fits a 390 px wide screen.

<img src="/img/band-coach/trainer-phone.png" alt="Band Coach on a 390 px wide phone: the instrument picker with More ways to practise open" width="390" height="844" loading="lazy">

## Instruments, file formats and tools {#instruments-file-formats-and-tools}

**Import:** a score (`.mid`, `.midi`, `.abc`, `.xml`, `.musicxml`, `.mxl`, `.gp`, `.gp5`), an audio file your browser can decode, a teacher's `.bandpack`, or a saved `.json`. Guitar Pro support is limited to `.gp5` (version 5.x) and `.gp` files.

**Export:** each song in the library exports as MIDI, MusicXML or ABC.

<img src="/img/band-coach/panel-songs.png" alt="Songs panel: built-in tunes, each with MIDI, MusicXML and ABC export buttons" width="1440" height="900" loading="lazy">

**More tools** (next to the instrument picker): Interval drill, Rhythm reading, Tuner and Capture a melody.

**More ways to practise** (each opens a panel below the trainer):

- **Songs:** practice a built-in tune or add your own.
- **My progress:** practice calendar, daily goal and results by instrument.
- **Ear training:** listening exercises with answer buttons.
- **Music theory:** lessons and a lookup for keys, scales and chords.
- **How to play it:** pick an instrument and note and see how to sound it.
- **Record a tune** and **Learn this:** turn a recording or score into a song to practice.
- **Play Along:** work with a song's decoded recording.

<img src="/img/band-coach/panel-history.png" alt="My progress panel: no sessions logged yet, a practice calendar and a daily minutes goal" width="1440" height="900" loading="lazy">

## Documentation

{{< system-docs name="Band Coach" >}}
