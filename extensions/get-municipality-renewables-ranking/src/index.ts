import { Router, Request, Response } from "express";

export default {
	id: "get-municipality-renewables-ranking",
	handler: (router: Router, { database }) => {
		router.get("/", async (req: Request, res: Response) => {
			const country = (req.query.country as string) || "DE";
			const regionParent = req.query.regionParent as string | undefined;

			try {
				// Step 1: Get all municipalities and populations
				let regionsQuery = database("regions")
					.select("id", "code_short", "population")
					.where("country", country)
					.andWhere("layer", "municipality");

				if (regionParent) {
					regionsQuery = regionsQuery.andWhereRaw(
						"JSON_CONTAINS(parents, JSON_OBJECT('id', ?))",
						[regionParent]
					);
				}

				const regions = await regionsQuery;
				const regionMap = new Map<string, { id: string; population: number }>();

				for (const r of regions) {
					if (r.code_short && r.population && r.population > 0) {
						regionMap.set(r.code_short, {
							id: r.id,
							population: r.population,
						});
					}
				}

				// Step 2: Get all relevant solar units in one query
				const allSolar = await database("energy_solar_units")
					.select("region")
					.sum({ power_kw: "power_kw" })
					.whereIn("region", Array.from(regionMap.keys()))
					.whereNotNull("commissioning_date")
					.andWhere((builder) =>
						builder
							.whereNull("shutdown_date")
							.orWhere("shutdown_date", ">", database.fn.now())
					)
					.groupBy("region");

				// Step 3: Merge and compute results
				const results = allSolar
					.map((row: any) => {
						const meta = regionMap.get(row.region);
						if (!meta) return null;

						const power_kw_sum = parseFloat(row.power_kw) || 0;
						const power_per_inhab = power_kw_sum / meta.population;

						return {
							region_id: meta.id,
							inhabitants: meta.population,
							power_kw_sum: Math.round(power_kw_sum * 1000) / 1000,
							power_kw_per_inhabitants:
								Math.round(power_per_inhab * 1_000_000) / 1_000_000,
						};
					})
					.filter(Boolean) as {
					region_id: string;
					inhabitants: number;
					power_kw_sum: number;
					power_kw_per_inhabitants: number;
				}[];

				// Step 4: Rank by power per inhabitant
				results.sort(
					(a, b) => b.power_kw_per_inhabitants - a.power_kw_per_inhabitants
				);

				const final = results.map((r, index) => ({
					place: index + 1,
					region_id: r.region_id,
					inhabitants: r.inhabitants,
					power_kw_sum: r.power_kw_sum,
					power_kw_per_inhabitants: r.power_kw_per_inhabitants,
				}));

				res.json(final);
			} catch (err: any) {
				res.status(500).json({
					error: "Failed to calculate solar power stats per municipality",
					details: err.message,
				});
			}
		});
	},
};
