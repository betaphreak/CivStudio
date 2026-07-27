package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.function.ToDoubleBiFunction;

import org.junit.jupiter.api.Test;

/**
 * The street router's graph and A* ({@code docs/towngen-port.md} T1, used by T5). The behaviour
 * that matters beyond "finds a path" is that a <b>weighted</b> route beats a short one — that is
 * the whole reason the street A* exists, so streets contour around a hill instead of climbing it.
 */
class GraphTest {

	private static final ToDoubleBiFunction<String, String> NO_HEURISTIC = (a, b) -> 0;

	@Test
	void findsTheCheapestPathNotTheShortestHopCount() {
		Graph<String> g = new Graph<>();
		g.addBiEdge("gate", "hill", 1);
		g.addBiEdge("hill", "plaza", 1);         // two hops, but straight over the hill
		g.addBiEdge("gate", "a", 0.2);
		g.addBiEdge("a", "b", 0.2);
		g.addBiEdge("b", "plaza", 0.2);          // three hops, contouring around it
		List<String> path = g.path("gate", "plaza", NO_HEURISTIC);
		assertEquals(List.of("gate", "a", "b", "plaza"), path);
		assertEquals(0.6, g.cost(path), 1e-9);
	}

	@Test
	void anUnreachableGoalIsAnEmptyPathNotAnException() {
		// §5.1: a gate walled off by a river must degrade to a straight line, never fail a layout
		Graph<String> g = new Graph<>();
		g.addBiEdge("gate", "a", 1);
		g.addEdge("island", "islet", 1);
		assertTrue(g.path("gate", "island", NO_HEURISTIC).isEmpty());
		assertTrue(g.path("gate", "nowhere", NO_HEURISTIC).isEmpty());
	}

	@Test
	void startEqualsGoalIsASingleNode() {
		Graph<String> g = new Graph<>();
		g.addBiEdge("a", "b", 1);
		assertEquals(List.of("a"), g.path("a", "a", NO_HEURISTIC));
	}

	@Test
	void directedEdgesAreRespected() {
		Graph<String> g = new Graph<>();
		g.addEdge("a", "b", 1);
		assertEquals(List.of("a", "b"), g.path("a", "b", NO_HEURISTIC));
		assertTrue(g.path("b", "a", NO_HEURISTIC).isEmpty(), "one-way stays one-way");
	}

	@Test
	void anAdmissibleHeuristicFindsTheSameCostAsDijkstra() {
		// a 12x12 lattice with a cost ridge down the middle, keyed by point so the heuristic can
		// be the real straight-line distance — the shape T5's street graph takes
		Graph<Pt> g = new Graph<>();
		int n = 12;
		for (int x = 0; x < n; x++) {
			for (int y = 0; y < n; y++) {
				Pt here = new Pt(x, y);
				if (x + 1 < n) {
					g.addBiEdge(here, new Pt(x + 1, y), ridge(x, y, x + 1, y));
				}
				if (y + 1 < n) {
					g.addBiEdge(here, new Pt(x, y + 1), ridge(x, y, x, y + 1));
				}
			}
		}
		Pt start = new Pt(0, 0), goal = new Pt(n - 1, n - 1);
		List<Pt> dijkstra = g.path(start, goal, (a, b) -> 0);
		List<Pt> astar = g.path(start, goal, (a, b) -> a.dist(b));
		assertEquals(g.cost(dijkstra), g.cost(astar), 1e-9,
				"an admissible heuristic changes the search, never the answer");
		assertTrue(astar.size() >= 2 * n - 1);
	}

	/** A cost surface with an expensive ridge at x == 6 — the hill a street should walk around. */
	private static double ridge(int x0, int y0, int x1, int y1) {
		double base = 1.0;
		return base + (x1 == 6 || x0 == 6 ? 4.0 : 0.0);
	}

	@Test
	void costOfADisconnectedPathIsInfiniteRatherThanWrong() {
		Graph<String> g = new Graph<>();
		g.addBiEdge("a", "b", 1);
		assertEquals(Double.MAX_VALUE, g.cost(List.of("a", "z")), 0.0);
		assertEquals(0.0, g.cost(List.of("a")), 0.0);
	}

	@Test
	void nodesAppearOnFirstUseInInsertionOrder() {
		Graph<String> g = new Graph<>();
		g.addEdge("a", "b", 1);
		g.addEdge("c", "a", 1);
		assertEquals(List.of("a", "b", "c"), List.copyOf(g.nodes()));
	}
}
