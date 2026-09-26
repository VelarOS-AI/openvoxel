# Audio source

The 51 FLAC recordings in `audio/` were copied without transcoding from
`SurvivalcraftApi-SCAPI1.9/Survivalcraft/Content/Assets/Audio/` in the
locally available Survivalcraft API project. The selected files cover block
placement, impacts, footsteps, rain, water, magma, and thunder.

Wind is generated separately in the web audio adapter from a six-second
filtered-noise buffer. Its gust envelope is shared with vegetation and water.
Snowfall uses this quiet wind bed, softened water ambience and the original
snow footsteps. Thunder playback accounts for source distance and event age.

Redistribution rights for these recordings should be confirmed before a
public release.
