// Dev helper: prints an OpenScreen project's zooms and pointer clicks.
//   node scripts/inspect.mjs <projectId>
import { connectOpenScreen } from "../src/openscreen.mjs";

const os = await connectOpenScreen();
try {
	const doc = await os.call("getCurrentDocument", { projectId: process.argv[2] });
	const pick = (o) => JSON.stringify(o, null, 1).slice(0, 2500);
	console.log("zooms:", pick(doc.zoomRegions ?? doc.zooms ?? doc.modifiers?.zooms ?? Object.keys(doc)));
	const track = await os.call("getCursorTrack", { projectId: process.argv[2] }).catch((e) => ({ error: e.message }));
	const clicks = (track.points ?? track.samples ?? []).filter((p) => p.click || p.type === "click");
	console.log("clicks:", clicks.length ? pick(clicks) : pick(track).slice(0, 800));
} finally {
	await os.close();
}
