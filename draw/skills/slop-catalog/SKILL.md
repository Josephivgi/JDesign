---
name: slop-catalog
title: AI slop catalog
group: Craft
description: Every known tell of model-drawn art, sorted by subject (scenes, animals, mascots, icons, logos, posters, maps, rooms, food, night). Read the parts that match what you are drawing.
---

# AI slop catalog

Read anti-slop first. This catalog is the long list behind it: the tells the user has rejected in JSlop, tells found in research on model-drawn SVGs and AI art, and the drawing fundamentals they break. Read "Every drawing", then each section that matches your subject. Each line is a tell, then what to do instead.

## Every drawing

### Structure
- Objects made of one primitive each (box, triangle, circle, ellipse), or stacked primitives. Draw one silhouette path per object with real parts inside it.
- Parts placed by coordinates and never checked: a wheel off its axle, a platform hanging over its support, a chimney above the roof, ears off the head, a handle that misses the cup. Compute each joint from the parent and crop view_drawing to every joint.
- Lines that stop short, fade out, or run past the edge they should meet. Close every outline; end every line on something.
- Rings, bands, straps or rails that stop partway around an object or attach to nothing.
- Objects that merge with no separation: a leg melting into a chair, hair into the background, a stem into the grass. Give overlapping things a clear edge, value change or gap.
- Things that could not be built: a railing with no posts, a roof with no wall under one side, furniture legs of different lengths or counts.
- Repeated patterns (tiles, bricks, panes, shingles) that change size or break off. Keep a pattern continuous across the surface, foreshortened with it.
- Extra or missing parts: three wheels on a bike, five-legged animals, fingers that vary in count, a duplicate handle.
- Stray dots, marks or shapes that are not anything. Delete them.

### Composition
- Subject dead center, eye level, seen straight on or exactly in profile, facing right. Pick a camera height and angle on purpose; three-quarter views and off-center placement read as drawn.
- Horizon line through the middle of the canvas. Put it high or low depending on what matters (sky or ground).
- No foreground, middle ground and background, so everything sits on one plane. Overlap things and change size, value and detail with distance.
- Tangents: two edges just touching (a tree top kissing the horizon, a roof touching the frame, an object resting exactly on the canvas edge). Either overlap clearly or leave a clear gap.
- Edges lined up by accident: parallel edges stacked on each other, trees, bushes or objects standing on one straight line across the picture. Place things at different depths in uneven groups.
- Every area equally busy, with no place for the eye to rest. Choose one focus with the most contrast and detail; leave real empty space elsewhere.
- Symmetry everywhere: mirrored scenes, balanced pairs, an object in each corner. Break it unless the subject is truly symmetric.
- The first layout kept even when it is wrong. Plan the layout before drawing; if the check shows a structural problem, redraw the object or move it, do not polish around it.

### Perspective
- Mixed eye levels: a table seen from above with legs seen straight on, a road from above with houses from the side.
- Parallel edges sent to different vanishing points, or unrelated edges sent to one.
- Ellipses (cup rims, bowl tops, wheels) that do not match the eye level: rims seen from above must be wider ellipses the further below eye level they are.
- Objects the same size near and far. Make far things smaller and higher on the ground plane.

### Light and shadow
- No light source, or several that disagree. Choose one direction before drawing.
- Cast shadows that point the wrong way, change angle between objects, or ignore the light height (low sun means long shadows).
- Shadows that do not start at the base of the object, so it floats. Add a dark contact shadow where things touch the ground or each other.
- Bright spots with no source. Every highlight faces the light.
- Shadows too pale to read. Form and cast shadows are clearly darker than the lit side.
- Hard and soft shadow edges mixed for the same light.
- Glow on things that do not give light.

### Line and texture
- Short loose strokes as texture: dashes on snow, water and pavement, lines on rocks and bark, fur strokes, cracks, lines between every brick, scattered dots. The user's most common reason. Never draw freestanding marks; show surface with shapes, planes and color patches.
- One stroke width everywhere. Use heavier outer contours and overlaps, lighter interior detail, tapered line ends.
- Every surface the same smoothness: wood, skin, metal and fabric look alike. Give each material its own shapes and color: wood has planks and a warmer shadow, metal has sharp light bands, cloth folds.
- Texture spread evenly over everything (dashes, dots, grain). Cluster it at edges, in shadow and on the focus.
- Detail at the same density everywhere. Detail goes where the eye should go.

### Color
- Every hue at full strength, or textbook pure red, orange, yellow, green, blue.
- Purple, violet and teal-and-orange defaults, purple-blue gradients, neon on a dark navy background.
- One flat fill per object. At least lit, mid and shadow tones, the shadow shifted in hue.
- A gradient on everything. Use gradients for sky and real light falloff only.
- Big areas of one strong saturated color. Keep large areas quiet and the strong color small.
- Muddy midtones: gray-olive, beige-gray, brown on brown, all middle values, no light idea. Choose a warm against cool light story and keep real darks and bright lit spots (the night street with amber lamps against deep blue passed).
- The opposite: a gray wash over everything, low contrast, every color pulled toward gray-blue. Keep real hue and a full value range; haze only in the far distance.

### Stock shorthand
- Clouds as lens shapes or three circles; a half sun on the horizon with dash reflections; water as parallel lines; grass as scattered dashes; triangle mountains with zigzag snow caps; pines as stacked triangles; lollipop trees; half-dome bushes; dot hedgerows; light beams as one see-through wedge.
- Rain as even straight diagonal streaks; snow as evenly scattered white dots. Show weather through its effects (wet reflections, darker surfaces, soft background, a few drops on glass).
- Sparkles and four-point stars as decoration; steam as two or three S-curls; swirls added to fill space.
- Stock props that always come with the subject: a sun in every outdoor scene, a crescent moon with stars in every night scene, a scarf on an animal, a basket on a bike.

## Scenes and landscapes
- Rocks as smooth blobs or triangles. Give them facets, ledges, cracks and a flat shadow side.
- Coastline as one smooth curve. Break it with inlets, rocks and foam where water meets land.
- Paths that are one smooth S of even width. Narrow them with distance and let edges wobble.
- Buildings with no ground contact: add a foundation, steps or grass overlapping the base.
- Trees with no trunk showing through, or a trunk that ends at the canopy edge.

## Animals and characters
- Head as a circle, body as an oval or dome, limbs as tubes. Build from the skeleton: skull, neck, chest, hips, legs with joints in the right places.
- Eyes, ears, mouth or whiskers placed beside the head instead of on it; ears that start outside the skull; eyes of different sizes by accident; pupils that look in different directions.
- Whiskers or a face drawn on an animal seen from behind.
- Feet missing, buried, or not touching the ground or branch; claws not wrapping around what they hold.
- Fur lines that run in every direction. Follow the body's form and growth direction.
- Long bendy limbs, tiny heads, no faces and blue or purple skin (Corporate Memphis). Avoid unless asked.
- The same averaged face on every character: symmetric, smooth, smiling.

## Mascots
- Theme symbols stuck on: code brackets, terminal prompts, gears, circuit lines on a coding mascot. Show the idea through pose, prop or character, not icons.
- A rounded robot with a screen face, two round eyes, blush circles and an antenna; a blob with giant orb eyes. Give the mascot one specific idea tied to the brand and a silhouette that reads in black.
- Features bolted on one by one. Design the whole character: posture, proportions and a pose that says something.

## Icons
- A rounded square with a gradient and a glyph in the middle; a sparkle; a generic checkmark, cloud or bolt. Find a mark specific to this app.
- Too much detail to read at 16 px. Check it small and in one color.
- Text inside the icon. Leave it out.
- A saturated full-color tile. Neutral base, small accent, or one color only.
- JDraw refuses these in an icon or a logo: a four-point sparkle, an orbit ring, one or two letters in a tile, a swoosh, a gradient that runs into purple or pink.

## Logos
- Circles, orbit rings, swirls, loops, sparks, leaves, shields, mountains, upward arrows: marks that fit hundreds of businesses. Ask what only this business has.
- A mark that only works with a gradient, glow or shadow. It must work flat and in black and white.
- Perfect symmetry by default; a designer breaks it on purpose.
- More than two typefaces; letters with uneven spacing or baselines.
- Text that changes color by letter or word. One color, simple.

## Posters, cards and anything with text
- No empty space; too much small text; several fonts competing. One or two fonts, a clear size hierarchy, real empty space.
- Invented facts: dates, prices, addresses, slogans the person did not give. Use only what you were told; leave space or a plain label otherwise.
- Mixed visual languages (flat vector next to a realistic object next to rough texture). Keep one style.
- Decoration recycled from every design: brush banners, circle icons, divider lines, badges. Use only what the message needs.
- Uneven kerning and baselines; text crowding the edge.

## Maps
- A parchment rectangle with a compass rose, a dotted path and a red X; V-shaped mountains; a palm tree. If you use a convention, draw it with care and make the land shape specific.
- Coastlines as smooth blobs. Use detailed, irregular coasts with bays and points.
- Labels in one font size scattered evenly. Size labels by importance and follow the features they name.

## Rooms and interiors
- Furniture floating with no shadow or floor contact; legs that do not reach the floor or differ in count.
- A floor and walls in different perspectives; a rug that does not lie flat in the same perspective as the floor.
- Books on shelves all the same height, color and lean. Vary them and let some lean or lie flat.
- Lamps that light nothing. A lamp casts warm light on what is near it and changes the shadows.

## Plants and flowers
- Daisy-type flowers with identical petals around a dot, all facing the viewer; leaves as identical flat almond shapes. Draw the real flower type, turned at different angles, some half open, leaves that twist and overlap.

## Vehicles and objects in scenes
- A car, bike or boat that floats above the road or water. It needs contact: tires flattened on the ground with a dark contact shadow, a hull sitting in the water with the waterline cutting it.

## Food and still life
- Bowls and cups as a flat ellipse plus a half circle. Draw the rim ellipse, the inner wall and the foot, all at one eye level.
- Steam as identical S-curls. Make steam faint, uneven and short, or skip it.
- Every item centered and symmetric; flowers fanned evenly in a vase. Overlap, vary heights, let some stems bend and leaves turn.
- Glass drawn as a solid. Show what is behind it, bent at the edges, with a few sharp highlights.

## Night scenes
- Crescent moon plus scattered four-point stars; everything navy blue with one glow. Keep stars small and varied, use a few colored lights and let them light their surroundings.
- Windows that glow but light nothing outside them.

## App screens and empty states
- A person or mascot with a giant magnifying glass, an empty box, a paper plane, floating clouds and plants. Draw something about this app's real content.
- Notion-style black and white doodles everywhere. One illustration only where it helps.

## Isometric
- Angles that drift from the projection, floor tiles that do not line up, objects drawn in normal perspective inside an isometric scene. Keep every edge on the same three axes.
