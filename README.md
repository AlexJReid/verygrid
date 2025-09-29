# verygrid

## What

A massive data grid experiment.

![verygrid](3.png)

## Implementation notes

- GPU rendering with **cell data and colour in GPU**
- Shaders used for parallel updates
- Vertex shader handles virtualization
- Text and editing rendered on overlay canvas

## Why

Sometimes a lot of high velocity data needs to be shown across several high resolution screens. Sometimes this is what users want.

Not everything can be a beautiful UI with perfect fonts and immaculate kerning. Sometimes muscle memory - knowing where to look, what keys to press and what information to radiate is the primary ask. Sometimes there's a LOT going on at the same time which needs to be visible. As ever, interfaces need to remain responsive, data should be instantaneous and resource usage should be as low as possible. (A mantra to live by.)

It is therefore disappointing that many data grids on the market, even the expensive commercial ones, perform horribly when showing a lot of fast moving data. Insane memory use, GC pauses, laggy scrolling, browser crashes, painting bugs and so on. Disclaimer: I'm not a front end expert so may have been using them incorrectly. I also appreciate that this is perhaps outside of their envelope of anticipated use.

Putting all of that aside, out of curiosity, I built a massive grid that leverages WebGPU!

You can see it here: https://xllify.com/verygrid/

**Try scrolling around a bit and hit option/alt for some stats. Check your CPU/GPU load.**

Currently desjtop only. You will need to toggle the WebGPU feature flag on macOS/iOS Safari.

I'm quite impressed how approaching a solved problem a bit differently with a number of old-school performance tricks yields something pretty fast and fit for purpose (at least on a M2/M4 Mac - my PC is old.)

Confession: My good friend claude.ai helped me with the WebGPU code and some ideas.

Usually, I'm a strong advocate of buy not build. "We're not in the business of building our own data grid, you buffoon."

But equally, perhaps in certain scenarios with very specific requirements, could it be that our ever-eager AI coding counterparts will shift that view?
