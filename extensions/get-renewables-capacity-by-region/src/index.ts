import { Router, Request, Response } from "express";
import { LRUCache } from "lru-cache";

/**
 * Installed capacity per region and energy carrier at a cut-off date.
 *
 * GET /get-renewables-capacity-by-region
 *   ?region=EMN                 comma list of region ids / codes (municipality,
 *                               district, state or metropolitan_region); omit for all of the country
 *   &level=district             district | municipality | total (default district)
 *   &date=2024-12-31            cut-off date (default today): units commissioned on or
 *                               before it and not shut down by then
 *   &carriers=solar,wind,...    default solar,wind,biomass,sewage_sludge,hydro (no storage);
 *                               add "storage" explicitly if needed
 *   &country=DE
 *
 * Response:
 *   { date, level, carriers, rows: [{ region, name, carriers: { solar: { units, net_power_kw }, ... },
 *     total_units, total_net_power_kw }], totals: { carriers, total_units, total_net_power_kw } }
 */

const cache = new LRUCache<string, any>({ max: 200, ttl: 1000 * 60 * 60 * 6 });

type Carrier = { table: string; where?: (q: any) => void };

const CARRIERS: Record<string, Carrier> = {
	solar: { table: "energy_solar_units" },
	wind: { table: "energy_wind_units" },
	biomass: {
		table: "energy_biomass_units",
		where: (q) => q.andWhere((b: any) => b.whereNull("type").orWhere("type", "!=", "Klärschlamm")),
	},
	sewage_sludge: {
		table: "energy_biomass_units",
		where: (q) => q.andWhere("type", "Klärschlamm"),
	},
	hydro: { table: "energy_hydro_units" },
	storage: { table: "energy_storage_units" },
};
const DEFAULT_CARRIERS = ["solar", "wind", "biomass", "sewage_sludge", "hydro"];
const LEVELS = ["district", "municipality", "total"];

type Resolved = { codes: string[]; prefixes: string[] };

function isUUID(str: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

async function resolveOne(database: any, input: string, country: string): Promise<Resolved> {
	const find = (withCountry: boolean) =>
		database("regions")
			.select("id", "code_short", "code", "layer", "country")
			.where((qb: any) => {
				if (isUUID(input)) qb.where("id", input);
				else qb.where("code_short", input).orWhere("code", input);
			})
			.modify((qb: any) => {
				if (withCountry) qb.andWhere("country", country);
			})
			.first();
	const row = (await find(true)) || (await find(false));

	if (!row) {
		// Bare AGS: short codes are prefixes, 8-digit codes exact matches
		return /^\d{1,7}$/.test(input) ? { codes: [], prefixes: [input] } : { codes: [input], prefixes: [] };
	}

	const code = String(row.code_short || row.code || "");
	switch (row.layer) {
		case "metropolitan_region": {
			const districts = await database("regions")
				.select("code_short", "code")
				.where("layer", "district")
				.andWhereRaw("parents::jsonb @> ?::jsonb", [JSON.stringify([{ id: row.id }])]);
			const prefixes = districts
				.map((d: any) => String(d.code_short || d.code || "").slice(0, 5))
				.filter(Boolean);
			return prefixes.length ? { codes: [], prefixes } : { codes: ["__none__"], prefixes: [] };
		}
		case "country":
			return { codes: [], prefixes: [] };
		case "state":
			return { codes: [], prefixes: [code.slice(0, 2)] };
		case "district":
			return { codes: [], prefixes: [code.slice(0, 5)] };
		default:
			return { codes: [row.code_short, row.code].filter(Boolean), prefixes: [] };
	}
}

async function resolveRegions(database: any, input: string | undefined, country: string): Promise<Resolved | null> {
	const parts = (input || "").split(",").map((s) => s.trim()).filter(Boolean);
	if (!parts.length) return null;
	const out: Resolved = { codes: [], prefixes: [] };
	for (const p of parts) {
		const r = await resolveOne(database, p, country);
		if (!r.codes.length && !r.prefixes.length) return null; // a whole country
		out.codes.push(...r.codes);
		out.prefixes.push(...r.prefixes);
	}
	return out;
}

function applyRegion(q: any, r: Resolved | null) {
	if (!r) return;
	q.andWhere((qb: any) => {
		for (const p of r.prefixes) qb.orWhere("region", "like", `${p}%`);
		if (r.codes.length) qb.orWhereIn("region", r.codes);
	});
}

export default {
	id: "get-renewables-capacity-by-region",
	handler: (router: Router, { database }: { database: any }) => {
		router.get("/", async (req: Request, res: Response) => {
			const country = String(req.query.country || "DE").toUpperCase();
			const level = String(req.query.level || "district").toLowerCase();
			const date = String(req.query.date || new Date().toISOString().slice(0, 10));
			const carriers = req.query.carriers
				? String(req.query.carriers).split(",").map((s) => s.trim()).filter(Boolean)
				: DEFAULT_CARRIERS;
			const region = req.query.region as string | undefined;

			if (!LEVELS.includes(level)) {
				return res.status(400).json({ error: `level must be one of ${LEVELS.join("|")}` });
			}
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				return res.status(400).json({ error: "date must be YYYY-MM-DD" });
			}
			const unknown = carriers.filter((c) => !CARRIERS[c]);
			if (unknown.length) {
				return res.status(400).json({
					error: `Unknown carrier(s) ${unknown.join(",")}. Use ${Object.keys(CARRIERS).join("|")}`,
				});
			}

			const cacheKey = [country, level, date, carriers.join(","), region || ""].join("|");
			const cached = cache.get(cacheKey);
			if (cached) return res.json(cached);

			try {
				const resolved = await resolveRegions(database, region, country);
				const keyExpr =
					level === "district" ? "substring(region from 1 for 5)" : level === "municipality" ? "region" : "'total'";

				const byKey = new Map<string, Record<string, { units: number; net_power_kw: number }>>();
				for (const carrier of carriers) {
					const cfg = CARRIERS[carrier]!;
					const q = database(cfg.table)
						.select(
							database.raw(`${keyExpr} as key`),
							database.raw("COUNT(*)::int as units"),
							database.raw("COALESCE(SUM(net_power_kw), 0)::float as net_power_kw")
						)
						.where("country", country)
						.whereNotNull("region")
						.whereNotNull("commissioning_date")
						.andWhere("commissioning_date", "<=", date)
						.andWhere((b: any) => b.whereNull("shutdown_date").orWhere("shutdown_date", ">", date));
					applyRegion(q, resolved);
					cfg.where?.(q);
					const rows = await q.groupByRaw("1");
					for (const r of rows) {
						const k = String(r.key);
						if (!byKey.has(k)) byKey.set(k, {});
						byKey.get(k)![carrier] = { units: r.units, net_power_kw: Math.round(r.net_power_kw) };
					}
				}

				// Region names: districts are stored with a 5-digit `code`, municipalities with an 8-digit `code_short`
				const names = new Map<string, string>();
				if (level !== "total" && byKey.size) {
					const keys = Array.from(byKey.keys());
					const field = level === "district" ? "code" : "code_short";
					for (let i = 0; i < keys.length; i += 500) {
						const rows = await database("regions")
							.select(field + " as key", "name")
							.where("layer", level)
							.andWhere("country", country)
							.whereIn(field, keys.slice(i, i + 500));
						for (const r of rows) names.set(String(r.key), r.name);
					}
				}

				const empty = () => ({ units: 0, net_power_kw: 0 });
				const totals: Record<string, { units: number; net_power_kw: number }> = {};
				for (const c of carriers) totals[c] = empty();

				const rows = Array.from(byKey.entries())
					.map(([key, values]) => {
						const row: Record<string, { units: number; net_power_kw: number }> = {};
						let units = 0;
						let kw = 0;
						for (const c of carriers) {
							const v = values[c] || empty();
							row[c] = v;
							units += v.units;
							kw += v.net_power_kw;
							totals[c]!.units += v.units;
							totals[c]!.net_power_kw += v.net_power_kw;
						}
						return {
							region: key,
							name: names.get(key) ?? null,
							carriers: row,
							total_units: units,
							total_net_power_kw: kw,
						};
					})
					.sort((a, b) => b.total_net_power_kw - a.total_net_power_kw);

				const result = {
					date,
					level,
					carriers,
					rows,
					totals: {
						carriers: totals,
						total_units: Object.values(totals).reduce((a, b) => a + b.units, 0),
						total_net_power_kw: Object.values(totals).reduce((a, b) => a + b.net_power_kw, 0),
					},
				};
				cache.set(cacheKey, result);
				return res.json(result);
			} catch (err: any) {
				return res.status(500).json({ error: "Failed to calculate capacity by region", details: err.message });
			}
		});
	},
};
