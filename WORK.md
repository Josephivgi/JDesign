# Next Cutline desktop work

Working notes from a Windows Record Center checkout.

## Already in this working tree, not in the installed AppX

Rebuild and reinstall AppX so Start menu Cutline matches source:

1. Record opens the overlay. Area, delay, and crop live on the bar. The rail is Source, Sound, and Max length.
2. Size box stays on screen over other apps with a large Record.
3. Enable screen button is gone. Preview is enough. Record turns the source on.
4. Same-version AppX install restores Cutline Allow for mic, camera, and screen capture.

## Record Center

5. Pause and resume a take without Stop.
6. Keep a recording clock on screen after leaving Record Center, same idea as the countdown overlay.
7. A Stop key that works while another app is focused.
8. Pick a window, not only a full display.

## Windows launch

10. Bump the AppX version on each `build:appx` so Windows updates the package instead of removing it first.
11. Daily use stays Start menu Cutline. `npm run start:electron` stays a source switch. Those are two Windows privacy rows.

## Edit videos

12. Styles apply. Catalog items still toast "Styles coming soon".
13. Undo the last studio apply.
14. Export the current edit to Finished videos from Edit videos, not only the Finished page.

## Library

15. Rename videos, images, and audio in place.
