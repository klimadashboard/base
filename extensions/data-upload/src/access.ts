/**
 * Who may upload data for which region. One row in `data_upload_access` grants
 * one email address access to one region (and optionally only some datasets);
 * an address with several rows can switch between its regions in the portal.
 * The collection is maintained in the Directus admin; it is not created here
 * (schema: email, region -> regions, datasets json, active, note).
 */
import type { EndpointExtensionContext } from "@directus/extensions";
import type { SchemaOverview } from "@directus/types";
import type { Knex } from "knex";
import { DATASETS } from "./datasets";

export const ACCESS_COLLECTION = "data_upload_access";

type Services = EndpointExtensionContext["services"];

/** The region an upload writes to, with every key the target collections use. */
export type Target = {
	/** regions.id (uuid) */
	id: string;
	name: string;
	/** name plus layer, e.g. "Stuttgart (Gemeinde)" */
	label: string;
	country: "DE" | "AT";
	/** official code for collections keyed by code instead of uuid (mobility_cars) */
	ags: string;
};

export type Grant = { region: string; datasets: string[] };

const LAYER_LABELS: Record<string, string> = {
	country: "Staat",
	state: "Bundesland",
	district: "Kreis/Bezirk",
	municipality: "Gemeinde",
};

/** Active grants of an address, merged per region. An empty dataset list means all datasets. */
export async function grantsFor(db: Knex, email: string): Promise<Grant[]> {
	const rows = await db(ACCESS_COLLECTION)
		.whereRaw("lower(trim(email)) = ?", [email])
		.where({ active: true })
		.select("region", "datasets");
	const all = DATASETS.map((d) => d.id);
	const byRegion = new Map<string, Set<string>>();
	for (const r of rows) {
		const raw = typeof r.datasets === "string" ? JSON.parse(r.datasets) : r.datasets;
		const ids = Array.isArray(raw) && raw.length ? raw.filter((id: string) => all.includes(id)) : all;
		const set = byRegion.get(r.region) ?? new Set<string>();
		ids.forEach((id: string) => set.add(id));
		byRegion.set(r.region, set);
	}
	return [...byRegion].map(([region, ids]) => ({ region, datasets: all.filter((id) => ids.has(id)) }));
}

export async function resolveTargets(
	ItemsService: Services["ItemsService"],
	schema: SchemaOverview,
	ids: string[],
): Promise<Target[]> {
	if (ids.length === 0) return [];
	const svc = new ItemsService("regions", { schema, accountability: null });
	const rows = await svc.readByQuery({
		filter: { id: { _in: ids } },
		fields: ["id", "name", "layer", "country", "code", "code_short", "parents"],
		limit: -1,
	});

	// Kreisfreie Städte: car stock etc. is published for the district, whose code is the
	// municipality's AGS without the trailing "000" (Stuttgart 08111000 -> 08111).
	const districtIds = rows.flatMap((r) => (r.parents ?? []).filter((p: any) => p?.layer === "district").map((p: any) => p.id));
	const districts = districtIds.length
		? await svc.readByQuery({ filter: { id: { _in: districtIds } }, fields: ["id", "code"], limit: -1 })
		: [];
	const districtCodes = new Set(districts.map((d) => d.code));

	return rows
		.map((r) => {
			let ags: string = r.code_short || r.code;
			if (r.layer === "municipality" && r.code_short?.endsWith("000") && districtCodes.has(r.code_short.slice(0, 5))) {
				ags = r.code_short.slice(0, 5);
			}
			return {
				id: r.id,
				name: r.name,
				label: `${r.name} (${LAYER_LABELS[r.layer] ?? r.layer})`,
				country: r.country,
				ags,
			} as Target;
		})
		.sort((a, b) => a.label.localeCompare(b.label, "de"));
}
