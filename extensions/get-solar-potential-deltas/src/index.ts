/**
 * get-solar-potential-deltas
 *
 * GET /get-solar-potential-deltas
 *
 * Returns raw monthly net deltas (added minus removed) per AGS code for all
 * DE roof-solar units (type=853, status=35). One call covers all regions —
 * the Python script handles AGS-prefix matching, cumulative sums, and the
 * Directus write.
 */

import { Router, Request, Response } from "express";

const SQL = `
SELECT
  region                                      AS ags_code,
  EXTRACT(YEAR  FROM commissioning_date)::int AS year,
  EXTRACT(MONTH FROM commissioning_date)::int AS month,
  SUM(net_power_kw)::float                    AS delta_power_kw,
  COUNT(*)::int                               AS delta_units
FROM energy_solar_units
WHERE type    = '853'
  AND status  = '35'
  AND country = 'DE'
  AND commissioning_date IS NOT NULL
  AND commissioning_date <= NOW()
GROUP BY region, year, month

UNION ALL

SELECT
  region                                   AS ags_code,
  EXTRACT(YEAR  FROM shutdown_date)::int   AS year,
  EXTRACT(MONTH FROM shutdown_date)::int   AS month,
  -SUM(net_power_kw)::float               AS delta_power_kw,
  -COUNT(*)::int                           AS delta_units
FROM energy_solar_units
WHERE type    = '853'
  AND status  = '35'
  AND country = 'DE'
  AND shutdown_date IS NOT NULL
  AND shutdown_date <= NOW()
GROUP BY region, year, month
`;

export default {
	id: "get-solar-potential-deltas",
	handler: (router: Router, { database }: { database: any }) => {
		router.get("/", async (_req: Request, res: Response) => {
			try {
				const result = await database.raw(SQL);
				return res.json(result.rows);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return res.status(500).json({ error: message });
			}
		});
	},
};
