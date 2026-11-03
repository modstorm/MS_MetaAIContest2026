/**
 * Shared JSDoc type definitions. This file has no runtime code; editors such as
 * VS Code read these for autocomplete. Reference them with
 * `@type {import('./types.js').TextureSlot}`.
 */

/**
 * Axis-aligned bounds in UV space.
 * @typedef {{ minU: number, minV: number, maxU: number, maxV: number }} UvBounds
 */

/**
 * One connected region of triangles in UV space.
 * @typedef {object} UvIsland
 * @property {number} triangleCount
 * @property {UvBounds} bounds
 * @property {number} area Area in UV units (0..1 squared).
 */

/**
 * Coverage statistics from rasterizing UV triangles into a coarse grid.
 * @typedef {object} UvCoverage
 * @property {number} resolution Grid resolution used for the estimate.
 * @property {number} coverage Fraction (0..1) of the UV square covered by at least one triangle.
 * @property {number} overlap Fraction (0..1) of covered cells hit by more than one island (mirrored / stacked UVs).
 */

/**
 * A unique base color texture (or an untextured material) plus everything that samples it.
 * @typedef {object} TextureSlot
 * @property {string} id Stable id within one analysis ("slot0", "slot1", ...).
 * @property {string} name
 * @property {import('three').Texture | null} texture The live base color map, or null when untextured.
 * @property {number} width
 * @property {number} height
 * @property {number} uvChannel UV channel the map samples (0 = uv, 1 = uv1, ...).
 * @property {import('three').MeshStandardMaterial[]} materials
 * @property {import('three').Mesh[]} meshes
 * @property {UvIsland[]} islands
 * @property {UvCoverage} coverage
 * @property {UvBounds} uvBounds
 * @property {boolean} tiled UVs extend outside 0..1, so the texture repeats.
 * @property {boolean} missingUvs At least one mesh using this slot has no UVs.
 * @property {string[]} otherMaps Other maps on the same materials (normalMap, roughnessMap, ...).
 * @property {number} triangleCount
 */

/**
 * @typedef {object} TextureLayout
 * @property {TextureSlot[]} slots
 * @property {number} meshCount
 * @property {number} materialCount
 * @property {number} triangleCount
 * @property {string[]} warnings Human readable notes (tiled UVs, missing UVs, overlap, unsupported materials).
 */

/**
 * @typedef {object} LoadedModel
 * @property {string} name
 * @property {import('three/examples/jsm/loaders/GLTFLoader.js').GLTF} gltf
 * @property {import('three').Group} scene
 */

/**
 * @typedef {'analyze' | 'plan' | 'generate' | 'postprocess' | 'apply' | 'done'} ReskinStage
 */

/**
 * @typedef {object} ReskinProgress
 * @property {ReskinStage} stage
 * @property {string} [slotId]
 * @property {string} message
 * @property {number} progress Overall progress 0..1.
 */

/**
 * Options for `ReskinPlugin.postPrompt`.
 * @typedef {object} PostPromptOptions
 * @property {string[]} [slotIds] Restrict to these slot ids. Default: all slots.
 * @property {number} [detailPreserve] How much of the original atlas's light/dark detail to keep (0..1). Default 0.35.
 * @property {boolean} [useVisionPlanning] Ask the vision model to describe atlas regions first. Default true.
 * @property {number} [maxTextureSize] Longest side of generated textures. Default: source size, capped at 2048.
 * @property {string} [extraInstructions] Free text appended to the model prompt.
 * @property {string | string[] | null} [userRules] The user's own hard rules (e.g. the editor's Context:
 *   "don't paint the windows"). Also on postSuggest. Sent unchanged and first in every Muse call
 *   (suggestion, every paint prompt, review) as "MOST IMPORTANT RULE (from the user): …"; they
 *   are never rewritten by Muse. They stay for later calls until another value is passed
 *   (null or [] clears them).
 * @property {boolean} [prefetchAreaThemes] postSuggest only: ask for the per-area theme split of
 *   the suggested prompt right away, so painting that prompt starts sooner. For editors that
 *   paint suggestion.prompt unchanged. Default false.
 * @property {'gltf' | 'image'} [imageOrder] Row order of the canvases handed out (slot results, their maps, textureUpdated).
 *   'gltf' (default): as stored on the model (glTF, top row = v 0). 'image': flipped into ordinary image order (top row = v 1),
 *   ready to save as image files. Defaults to what postModel was given. The model's own textures never change.
 * @property {boolean | 'always'} [normalMaps] Regenerate normal maps the model already has (default true); 'always' also adds them where missing.
 * @property {boolean | 'always'} [roughnessMaps] Regenerate roughness maps the model already has (default true); 'always' also adds them where missing.
 * @property {number} [normalStrength] Strength of derived normal maps. Default 2.
 * @property {boolean} [fast] Provider speed mode (Muse: no web/image search, low reasoning, smaller uploads). Default: provider's setting (on).
 * @property {boolean} [localSmallParts] Tint small untextured parts from the new palette instead of a model call. Default true.
 * @property {number} [smallPartRatio] "Small" = bounding radius below this fraction of the model's. Default 0.2.
 * @property {'auto' | 'none' | 'flipV' | 'flipH' | 'rot90' | 'rot180' | 'rot270' | { rot: number, flipX: boolean }} [orientation]
 *   How to turn the atlas before sending it to the model (and back after). 'auto' (default) uses the 3D data so the
 *   head/face (or the largest part) is upright.
 * @property {boolean} [cleanTinyIslands] Fill each tiny island (fingers, buttons) with one solid color. Default true.
 * @property {number} [tinyIslandFraction] "Tiny" = fewer texels than this fraction of the image. Default 0.002.
 * @property {'auto' | 'parts' | 'atlas'} [paintMode] 'auto' (default) paints atlases shared by several parts one part at a time; 'atlas' paints the whole atlas in one call.
 * @property {'' | 'low' | 'high'} [imageReasoning] Muse Image reasoning strength for this run ('high' = more careful, same price per image; '' = default, low in fast mode).
 * @property {number} [partConcurrency] Parallel Muse calls in part-by-part mode. Default 4.
 * @property {boolean} [strandHair] Shade hair made of strands (cards / spikes) strand by strand
 *   in the painted hair color: dark roots, light tips, streaks along each strand. Default true.
 * @property {boolean} [fixSkinLeftovers] Fill small skin-colored patches left in clothing zones. Default true.
 * @property {boolean} [handsAsMaterial] Paint the hands zone from a seamless material texture (gloves or skin), shaded by the original, instead of an image edit. Default true.
 * @property {boolean} [samCheck] After each area is painted, ask SAM 3.1 whether things that belong to other areas
 *   (faces, people, shoes; per asset class) were painted into it, and repaint that area once if so. Turns itself off
 *   for the run if SAM cannot be reached. Default true (only with a provider that has segment()).
 * @property {boolean} [samMaskedRepaint] When the SAM check flags an area, take only the pixels SAM marked (grown and
 *   feathered) from the repaint and keep the first paint everywhere else; the whole repaint is the fallback. Default true.
 * @property {boolean} [plainNarrowStrips] Narrow pieces between two limbs (inseam strip) get the plain fabric color. Default true.
 * @property {{ image: CanvasImageSource, slot?: string, rect?: number[], flipY?: boolean }[]} [templates] Artists' templates (panel outlines and labels laid out like the texture); each area is sent to Muse with its part of the template. Also settable for every run with plugin.setProfile({ templates, panels }).
 * @property {{ zone?: string, area?: string, slot?: string, facing: 'front' | 'back', rect: number[] }[]} [panels] Exact front / back panels in texture fractions [u0, v0, u1, v1], used instead of reading them from the 3D data.
 * @property {string[]} [locked] Area names that keep their current paint (default: plugin.locked).
 * @property {number} [edgePadding] Pixels (at 1024px) to grow island colors into gaps, against seams. Default 12; 0 = off.
 * @property {Suggestion} [suggestion] Result of postSuggest: its per-region plans are used instead of a new layout reading.
 * @property {AbortSignal} [signal]
 */

/**
 * What the art-director step (postSuggest) recommends.
 * @typedef {object} Suggestion
 * @property {string} theme The user's original theme.
 * @property {string} subject What the vision model thinks the object is.
 * @property {string} prompt The recommended, more detailed prompt.
 * @property {{ name: string, description?: string }[]} parts Visible parts it identified.
 * @property {Record<string, LayoutPlan>} plans Per-slot region plans (slotId -> plan).
 * @property {string} [tips]
 * @property {HTMLCanvasElement} sheet The six-view contact sheet that was sent.
 * @property {{ name: string, axis: string, canvas: HTMLCanvasElement }[]} views
 * @property {Record<string, string>} [partRoles] What Muse says each listed part is, judged from
 *   the renders: 'body' | 'wheel' | 'tyre' | 'light' | 'glass' | 'trim' | 'interior' | 'other'.
 *   Used before part names for the vehicle rules and body panels.
 * @property {ThinkingEntry[]} [thinking] What was decided and asked while making this suggestion.
 */

/**
 * Identity of a texture in the source file, on textureUpdated events, slot results and
 * failed slots. For normal / roughness maps it is the original map being replaced (all
 * null if the model had none and one was created).
 * @typedef {object} TextureIdentity
 * @property {string | null} textureName The three.js texture's name (from the glTF image / texture).
 * @property {string | null} textureUuid The three.js texture's uuid in the loaded scene.
 * @property {number | null} textureIndex Index into the glTF `textures[]` array.
 * @property {number | null} imageIndex Index into the glTF `images[]` array.
 * @property {string | null} imageName The glTF image's `name`.
 */

/**
 * @typedef {object} PostTextureOptions
 * @property {string} theme What to paint, e.g. "lava cracks", "sunset over the sea".
 * @property {string} [id] Your own id for this job (e.g. the editor's image id); echoed on every event and the result.
 * @property {string} [name] Name used in prompts and messages (default: the input's name or the id).
 * @property {string} [assetClass] 'sky', 'material' (tiling material / track), 'terrain', … or any registered class.
 *   Guessed from context, theme and name if left out.
 * @property {string} [context] What it is for, sent to Muse ("race track asphalt seen from above").
 * @property {boolean | 'both' | 'x' | 'y' | 'none' | 'equirect' | 'sky'} [wrap] Which edges must join.
 *   Default: sky → 'equirect' (left/right + calm poles); seamless classes → 'both'; else what the source already does.
 * @property {boolean} [fixSeams=true] Blend the wrap seams locally (offset-by-half) when Muse's output does not wrap.
 * @property {number} [seamBand=0.125] Fraction of the size used for the seam blend at each edge.
 * @property {boolean} [calmPoles=true] Equirect only: fade the top and bottom rows to their average.
 * @property {boolean} [normalMap] Return a normal map (default true, false for skies).
 * @property {boolean} [roughnessMap] Return a roughness map (default true, false for skies).
 * @property {HTMLCanvasElement | HTMLImageElement | Blob | string} [normal] The original normal map, blended under the new detail.
 * @property {HTMLCanvasElement | HTMLImageElement | Blob | string} [roughness] The original roughness map (glTF G channel), mixed in.
 * @property {number} [normalStrength=2]
 * @property {number} [baseRoughness=0.7]
 * @property {number} [maxTextureSize=2048] Output is the source size, scaled down to fit this.
 * @property {number} [width] Only when generating (input null): output size (default 1024, sky 1024×512).
 * @property {number} [height]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} TextureResult
 * @property {string} id
 * @property {string} name
 * @property {string} assetClass
 * @property {'both' | 'x' | 'y' | 'none' | 'equirect'} wrap
 * @property {HTMLCanvasElement} canvas New base color (sRGB).
 * @property {HTMLCanvasElement | null} normal Tangent-space normal map (glTF convention, +Y up).
 * @property {HTMLCanvasElement | null} roughness glTF metallicRoughness layout: G = roughness, B = metalness.
 * @property {{ before: { x: number, y: number }, after: { x: number, y: number }, blended: { x: boolean, y: boolean, poles: boolean } } | null} seams
 *   Seam measure (about 1 = tiles, 3+ = visible) before and after the local blend.
 * @property {string} theme
 * @property {string | null} context
 * @property {number} width
 * @property {number} height
 * @property {number} durationMs
 * @property {object} usage Session Muse usage so far (shared by all jobs on this instance).
 */

/**
 * @typedef {object} ReskinSlotResult
 * @property {string} slotId
 * @property {string} slotName
 * @property {string | null} textureName See TextureIdentity (also textureUuid, textureIndex, imageIndex, imageName).
 * @property {HTMLCanvasElement} canvas Final base color applied to the model.
 * @property {HTMLCanvasElement} raw Image the provider returned, before resize and post-processing.
 * @property {LayoutPlan | null} [plan] Vision plan used to build the prompt.
 * @property {string} prompt
 */

/**
 * @typedef {object} ReskinResult
 * @property {string} prompt
 * @property {ReskinSlotResult[]} slots
 * @property {number} recoloredMaterials Materials tinted instead of textured (no UVs could be made).
 * @property {{ slotId: string, name: string, error: string, step?: string }[]} failed Texture slots that could not be painted (they keep their original texture).
 * @property {number} durationMs
 * @property {{ reskin: object, session: object, reskinCost: number, sessionCost: number, text: string }} [usage]
 *   Muse usage so far for this reskin (suggestion + paint) and the session, with cost estimates in dollars.
 * @property {ThinkingEntry[]} thinking What was decided and asked during this call, in order
 *   (also on Suggestion.thinking, postReview()'s `thinking`, and live as 'thinking' events).
 */

/**
 * One step of "what Muse is thinking", for an editor to show. Every entry has
 * `step`, `text` (one readable line) and `at` (ms timestamp); the other fields depend on the step:
 * - 'identify': Muse looked at the six views. subject, assetClass, prompt, parts, plans.
 * - 'assetClass': the class used. assetClass, source ('set by the editor' | 'Muse identified it' |
 *   'guessed from names'), rules (string[] sent to Muse), paintMode, detailPreserve, samZones.
 * - 'zones': SAM 3.1 zones found. zones (per slot summary), notSeen (concepts not found).
 * - 'plan': the paint plan of one texture. slotId, slotName, mode ('parts' | 'atlas'),
 *   areas: { name, zone?, action: 'paint' | 'keep' | 'reuse', why?, mergedFrom?, paint? }[].
 * - 'ask': a question to Muse Spark. model, url, status, ms, ok, question, instructions, error?.
 * - 'paint': one Muse Image request. model, url, status, ms, ok, prompt (the exact text sent), error?.
 * - 'kept': vehicle lights / tyre treads given back their original pixels. slotId, slotName,
 *   lightTriangles, treadTriangles, keptPixels, share (of the texture), bodyColorRepaintedPixels,
 *   oldBodyColor ([r, g, b] or null).
 * - 'parts': what each part is for the vehicle rules. decisions: { name, role, source: 'Muse' |
 *   'Muse (over its name)' | 'SAM' | 'name', wheels? }[], rejected: { name, reason }[]
 *   (a "wheel" that isn't round, or a "light" too big to be one, is painted).
 * - 'check': the final texture compared with the plan. unpainted: { area, share }[] (areas
 *   over `limit` that still show the original; the next review asks to repaint them).
 * - 'review': the review of the result. issues ({ area, problem, fix }[]), lessons, learned.
 * - 'note': every 'warning' message, so the log reads in one place.
 * - 'voice': a spoken theme transcribed by Muse Voice Transcribe (postVoice). text, durationMs.
 * @typedef {{ step: string, text: string, at: number } & Record<string, any>} ThinkingEntry
 */

/**
 * What the vision model reports about a texture atlas.
 * @typedef {object} LayoutPlan
 * @property {string} subject
 * @property {{ name: string, description?: string, bbox?: [number, number, number, number] }[]} regions
 *   bbox is a normalized 0..1000 box [x0, y0, x1, y1] in image space.
 * @property {string} [style]
 * @property {string} [raw]
 */

export {};
