# Piano Roll Player

A MIDI viewer that scrolls notes right to left or drops them top to bottom onto a piano keyboard. It can also convert solo piano recordings (MP3, WAV, …) to MIDI, entirely in the visitor's browser. Nothing is uploaded anywhere.

## Put it on GitHub Pages

1. Create a new public repository on GitHub, for example `piano-roll`.
2. Upload **everything in this folder** to the repository root, keeping the folder structure (`index.html`, `js/`, `model/`, `vendor/`, `.nojekyll`).
   - On the website: **Add file → Upload files**, then drag the folder's contents in. The model file is 49 MB, which is under GitHub's 100 MB per-file limit. GitHub may show a warning for files over 50 MB, but this one is under that too.
   - Or with git:
     ```bash
     git init
     git add .
     git commit -m "Piano Roll Player"
     git branch -M main
     git remote add origin https://github.com/<you>/piano-roll.git
     git push -u origin main
     ```
3. In the repository, open **Settings → Pages**. Under **Build and deployment**, set **Source** to *Deploy from a branch*, then pick **main** and **/ (root)**, and click **Save**.
4. After a minute or two the site is live at `https://<you>.github.io/piano-roll/`.

To test it on your own computer first, the page has to be served over http (opening `index.html` directly with a `file://` address blocks the converter). For example, run this inside the folder and open http://localhost:8000:

```bash
python -m http.server 8000
```

## How the converter works

- **Convert MP3 to MIDI…** runs the *High-resolution Piano Transcription* note model by Qiuqiang Kong et al. (ByteDance, 2020). It's the same model as the `piano_transcription_inference` Python package, exported to ONNX with half-precision weights and run with onnxruntime-web.
- Tested against the Python package on a 3:44 recording, it produced the same notes: 3,468 vs 3,473, 99.8% identical, with the same lengths and velocities.
- The first conversion downloads the 49 MB model. After that it's kept in the browser's cache storage, so later conversions start immediately.
- Speed depends on the computer. Expect roughly 1–3 minutes for a 4-minute song, because GitHub Pages can't enable the multi-threaded mode.
- The sustain pedal isn't transcribed. Notes end when the key is released.
- If the model can't load, the page falls back to a built-in quick converter. It's less accurate (roughly 60% note agreement with the model) but still usable.
- **Save MIDI** downloads the result as a standard `.mid` file.

## Credits and licences

- Piano transcription model: Q. Kong, B. Li, X. Song, Y. Wan and Y. Wang, "High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times", 2020. Code: https://github.com/bytedance/piano_transcription (the `piano_transcription_inference` package is MIT-licensed). Weights: https://zenodo.org/record/4034264. Check the licence on that Zenodo record before using this commercially.
- onnxruntime-web 1.20.1, © Microsoft, MIT licence.
- The demo tune is the opening of Beethoven's *Für Elise* (public domain).
