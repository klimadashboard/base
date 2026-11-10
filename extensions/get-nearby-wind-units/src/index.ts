export default {
	id: "get-nearby-wind-units",
	handler: (router: Router, { database }) => {
		router.get("/", async (req: Request, res: Response) => {
			const lat = parseFloat(req.query.lat as string);
			const lon = parseFloat(req.query.lon as string);
			const radiusKm = parseFloat((req.query.radius_km as string) || "50");

			if (isNaN(lat) || isNaN(lon)) {
				return res.status(400).json({
					error: "Invalid or missing lat/lon parameters",
				});
			}

			try {
				const query = database("energy_wind_units")
					.whereNotNull("lat")
					.whereNotNull("lon")
					.where("status", "35") // status = "In Betrieb"
					.whereNull("shutdown_date") // not shut down
					.andWhereRaw(
						`6371 * 2 * ASIN(SQRT(
							POWER(SIN(RADIANS(? - lat) / 2), 2) +
							COS(RADIANS(?)) * COS(RADIANS(lat)) *
							POWER(SIN(RADIANS(? - lon) / 2), 2)
						)) < ?`,
						[lat, lat, lon, radiusKm]
					)
					.select("*")
					.limit(100); // prevent overload

				const results = await query;
				res.json(results);
			} catch (err: any) {
				console.error("Failed to query nearby wind units", err);
				res.status(500).json({
					error: "Failed to fetch nearby wind units",
					details: err.message,
				});
			}
		});
	},
};
