import { Router, Request, Response } from "express";

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
let cache: {
	region: string | undefined;
	timestamp: number;
	data: any;
} | null = null;

export default {
	id: "get-balkonkraftwerke",
	handler: (router: Router, { services }) => {
		const { ItemsService } = services;

		router.get("/", async (req: Request, res: Response) => {
			const region = req.query.region as string | undefined;

			// Serve from cache if valid
			if (
				cache &&
				cache.region === region &&
				Date.now() - cache.timestamp < CACHE_DURATION_MS
			) {
				return res.json({
					...cache.data,
					cache_created: new Date(cache.timestamp).toISOString(),
				});
			}

			try {
				const service = new ItemsService("energy_solar_units", {
					schema: req.schema,
					database: req.database,
					accountability: req.accountability,
				});

				const filter: any = {
					type: { _eq: 2961 },
					commissioning_date: { _nnull: true },
				};
				if (region) filter.region = { _eq: region };

				const rows = await service.readByQuery({
					fields: ["commissioning_date", "shutdown_date", "power_kw"],
					filter,
					limit: -1,
				});

				const now = new Date();
				const currentYear = now.getFullYear();
				const yearRange = Array.from(
					{ length: currentYear - 2000 + 1 },
					(_, i) => 2000 + i
				);

				const statsPerYear: Record<
					number,
					{ added_units: number; added_kw: number }
				> = {};
				for (const year of yearRange) {
					statsPerYear[year] = { added_units: 0, added_kw: 0 };
				}

				for (const row of rows) {
					const commissioningDate = new Date(row.commissioning_date);
					const commissioningYear = commissioningDate.getFullYear();
					if (commissioningYear < 2000 || commissioningDate > now) continue;

					const shutdownDate = row.shutdown_date
						? new Date(row.shutdown_date)
						: null;

					const isStillActive = !shutdownDate || shutdownDate > now;

					if (isStillActive) {
						statsPerYear[commissioningYear].added_units += 1;
						statsPerYear[commissioningYear].added_kw += row.power_kw ?? 0;
					}
				}

				const result = [];
				let cumulative_units = 0;
				let cumulative_kw = 0;

				for (const year of yearRange) {
					const { added_units, added_kw } = statsPerYear[year];
					cumulative_units += added_units;
					cumulative_kw += added_kw;

					result.push({
						year,
						added_units,
						added_kw: Math.round(added_kw * 100) / 100,
						cumulative_units,
						cumulative_kw: Math.round(cumulative_kw * 100) / 100,
					});
				}

				const responseData = {
					result,
					cache_created: now.toISOString(),
				};

				cache = {
					region,
					timestamp: Date.now(),
					data: responseData,
				};

				res.json(responseData);
			} catch (err: any) {
				res.status(500).json({
					error: "Failed to fetch Balkonkraftwerke stats",
					details: err.message,
				});
			}
		});
	},
};
