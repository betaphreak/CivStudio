package com.civstudio.server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Founds the Phase-A caravan-demo session once the Spring context is ready (the live deployment
 * at {@code dev.civstudio.com} hosts this demo — one standard colony plus six marching
 * caravans). Runs on startup via {@link ApplicationRunner}; the session parameters come from
 * {@link CivStudioProperties.Demo}. A founding failure is logged, not fatal — the server still
 * serves the map bundle and any other sessions.
 *
 * <p>Also the one place that knows <em>how</em> to deal the demo, so the admin restart
 * ({@code POST /api/admin/demo/restart} → {@link #reseed()}) and the boot both go through
 * {@link #seed(boolean)} rather than each assembling their own idea of what the demo is.
 */
@Component
public class DemoSessionSeeder implements ApplicationRunner {

	private static final Logger log = LoggerFactory.getLogger(DemoSessionSeeder.class);

	private final SessionHost host;
	private final CivStudioProperties props;

	public DemoSessionSeeder(SessionHost host, CivStudioProperties props) {
		this.host = host;
		this.props = props;
	}

	@Override
	public void run(ApplicationArguments args) {
		CivStudioProperties.Demo demo = props.getDemo();
		if (!demo.isEnabled()) {
			log.info("demo session disabled (civstudio.demo.enabled=false)");
			return;
		}
		try {
			seed(false);
		} catch (RuntimeException e) {
			log.error("failed to seed the demo session", e);
		}
	}

	/**
	 * Throw the current demo away and deal a fresh one — the admin "restart demo" action.
	 *
	 * <p>Unconditional, unlike the boot path: a restart is a deliberate request for a NEW run, so it
	 * forgets the old id whatever state it was in rather than only when the run had ended. That is
	 * safe for this run and this run only — the demo is a fixture, the one session allowed to forget
	 * itself (see {@link #seed}).
	 *
	 * @return the freshly dealt session
	 * @throws IllegalStateException if the demo is disabled on this server
	 */
	public HostedSession reseed() {
		if (!props.getDemo().isEnabled())
			throw new IllegalStateException("the demo is disabled on this server "
					+ "(civstudio.demo.enabled=false)");
		return seed(true);
	}

	/**
	 * Deal the demo.
	 *
	 * <p>The demo's colony can collapse — that is the point of it — and a finished run is finished,
	 * so a fresh boot would otherwise find its own shop window permanently dead. The demo is a
	 * FIXTURE, not a record of anyone's play, so it is the one thing allowed to forget itself and
	 * start over. A ranked Timeline must never take this path: its verdict is the whole product.
	 * (When the public site points at the live Timeline — docs/spectator-lobby.md amendment 3 —
	 * this reseeding goes away with the demo.)
	 *
	 * @param force whether to discard an existing run of this id outright, rather than only after it
	 *              has finished
	 * @return the hosted demo session
	 */
	private HostedSession seed(boolean force) {
		CivStudioProperties.Demo demo = props.getDemo();
		SessionSpec spec = SessionSpec.leagueDemo(demo.getSeed(), demo.getProvinceId());
		if (force)
			host.forget(spec.id());   // stops it too — forget() removes before erasing the record
		HostedSession hs;
		try {
			hs = host.create(spec);
		} catch (SessionHost.RunFinishedException over) {
			log.info("the demo run {} is over ({}) — forgetting it and dealing a fresh one",
					spec.id(), over.getMessage());
			host.forget(spec.id());
			hs = host.create(spec);
		}
		hs.setTickRateMillis(demo.getTickRateMillis());
		hs.kind().begin(hs);   // the demo (DEMO kind) runs immediately (docs/session-management.md)
		log.info("seeded demo session {} ({} cities in a league, ~{}ms/tick)", hs.id(),
				hs.colonies().size(), demo.getTickRateMillis());
		return hs;
	}
}
