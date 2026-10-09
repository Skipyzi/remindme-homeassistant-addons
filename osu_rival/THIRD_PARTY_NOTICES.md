# osu!lazer rule ports

The algorithms in `rival/rules.py`, `rival/stacking.py`, slider tick generation
in `rival/beatmaps.py`, the environment's input ordering and slider judgments,
and `web/rules.js` are derived from ppy/osu under the MIT license.

Source revision: `7e25f111466f1b5648d86856e5737d852402effe`.
[Upstream source](https://github.com/ppy/osu/tree/7e25f111466f1b5648d86856e5737d852402effe).
Relevant source files:

- `osu.Game.Rulesets.Osu/Scoring/OsuHitWindows.cs`
- `osu.Game.Rulesets.Osu/UI/StartTimeOrderedHitPolicy.cs`
- `osu.Game.Rulesets.Osu/Objects/Drawables/SliderInputManager.cs`
- `osu.Game.Rulesets.Osu/Objects/Drawables/DrawableSliderHead.cs`
- `osu.Game.Rulesets.Osu/Objects/Drawables/DrawableSliderTail.cs`
- `osu.Game.Rulesets.Osu/Objects/SliderTailCircle.cs`
- `osu.Game/Rulesets/Objects/SliderEventGenerator.cs`
- `osu.Game/Rulesets/Scoring/HitResult.cs` and `ScoreProcessor.cs`
- `osu.Game.Rulesets.Osu/Beatmaps/OsuBeatmapProcessor.cs`
- `osu.Game.Rulesets.Osu/Objects/Spinner.cs`
- `osu.Game.Rulesets.Osu/Objects/Drawables/DrawableSpinner.cs`
- `osu.Game.Rulesets.Osu/Objects/Drawables/SpinnerSpinHistory.cs`

The app targets default, unmodified lazer gameplay. It does not run the native
client. Input is sampled at 60 Hz, slider curves are sampled approximations,
and audio, health/failure and mod-specific behavior are not implemented.
Accuracy uses the native component weights and combo rules. The displayed
points are accuracy points, not lazer's normalized leaderboard score or pp.
Spinner bonuses do not affect accuracy and are not included in practice points.

## MIT license

Copyright (c) 2025 ppy Pty Ltd <contact@ppy.sh>.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
