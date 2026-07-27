package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.function.ToDoubleBiFunction;

/**
 * A weighted directed graph with A* — the street router of {@code docs/towngen-port.md} §5 (T5),
 * which walks from each gate to the plaza over a cost surface rather than in a straight line.
 * <p>
 * Generic in the node type so the geometry core stays free of anything sim-shaped: T5 will key it
 * by wall vertex and patch corner, tests key it by string. Nodes must have sane {@code equals}/
 * {@code hashCode}, which {@link Pt} being a record gives for free.
 * <p>
 * <b>The weight function is the whole point.</b> Plain distance produces streets that run straight
 * up a hill and swim across a river. T5 supplies {@code distance × (1 + k·|Δh|)} plus the water
 * terms (sea blocked, a river crossable at bridge cost) as one weight, and A* then contours around
 * a hill — per the plan, "one line; most of what separates a plausible town map from a convincing
 * one". Nothing about that lives here: this class only promises to honour the weights it is given.
 *
 * @param <T> the node type
 */
public final class Graph<T> {

	private final Map<T, List<Edge<T>>> out = new LinkedHashMap<>();

	/**
	 * One weighted directed link.
	 *
	 * @param to     the node it leads to
	 * @param weight its cost, which must be non-negative for A* to be admissible
	 * @param <T>    the node type
	 */
	public record Edge<T>(T to, double weight) {
	}

	/** Add a directed link {@code a → b}. Nodes appear on first use; parallel edges are kept. */
	public void addEdge(T a, T b, double weight) {
		out.computeIfAbsent(a, k -> new ArrayList<>()).add(new Edge<>(b, weight));
		out.computeIfAbsent(b, k -> new ArrayList<>());
	}

	/** Add links both ways between {@code a} and {@code b}, at the same cost. */
	public void addBiEdge(T a, T b, double weight) {
		addEdge(a, b, weight);
		addEdge(b, a, weight);
	}

	/** The links leaving {@code node} — empty for an unknown node. */
	public List<Edge<T>> edgesFrom(T node) {
		return out.getOrDefault(node, List.of());
	}

	/** Every node, in insertion order. */
	public Set<T> nodes() {
		return out.keySet();
	}

	/**
	 * The cheapest path from {@code start} to {@code goal} by A*, inclusive of both ends, or an
	 * <b>empty list</b> when the goal is unreachable.
	 * <p>
	 * Unreachable is a result, not an exception: a gate can end up walled off by a river or a
	 * blocked cell, and the caller's answer is to fall back to a straight line, not to fail the
	 * layout (§5.1 — a render feature must never be able to hang a session).
	 *
	 * @param start     the first node
	 * @param goal      the node to reach
	 * @param heuristic an admissible estimate of remaining cost between two nodes — it must never
	 *                  overestimate, or the path found may not be the cheapest; {@code (a, b) -> 0}
	 *                  degrades A* to Dijkstra, which is always safe
	 * @return the path from {@code start} to {@code goal}, or an empty list
	 */
	public List<T> path(T start, T goal, ToDoubleBiFunction<T, T> heuristic) {
		if (start.equals(goal)) {
			return List.of(start);
		}
		Map<T, Double> best = new HashMap<>();
		Map<T, T> from = new HashMap<>();
		Set<T> done = new HashSet<>();
		PriorityQueue<Step<T>> open = new PriorityQueue<>(Comparator.comparingDouble(Step::f));
		best.put(start, 0.0);
		open.add(new Step<>(start, heuristic.applyAsDouble(start, goal)));
		while (!open.isEmpty()) {
			Step<T> cur = open.poll();
			if (cur.node().equals(goal)) {
				return rebuild(from, goal);
			}
			if (!done.add(cur.node())) {
				continue;
			}
			double g = best.getOrDefault(cur.node(), Double.MAX_VALUE);
			for (Edge<T> e : edgesFrom(cur.node())) {
				if (done.contains(e.to())) {
					continue;
				}
				double ng = g + e.weight();
				if (ng < best.getOrDefault(e.to(), Double.MAX_VALUE)) {
					best.put(e.to(), ng);
					from.put(e.to(), cur.node());
					open.add(new Step<>(e.to(), ng + heuristic.applyAsDouble(e.to(), goal)));
				}
			}
		}
		return List.of();
	}

	/** The cost of a path, or {@code 0} for one of fewer than two nodes. */
	public double cost(List<T> path) {
		double c = 0;
		for (int i = 0; i + 1 < path.size(); i++) {
			double best = Double.MAX_VALUE;
			for (Edge<T> e : edgesFrom(path.get(i))) {
				if (e.to().equals(path.get(i + 1))) {
					best = Math.min(best, e.weight());
				}
			}
			if (best == Double.MAX_VALUE) {
				return Double.MAX_VALUE;
			}
			c += best;
		}
		return c;
	}

	private List<T> rebuild(Map<T, T> from, T goal) {
		List<T> path = new ArrayList<>();
		for (T n = goal; n != null; n = from.get(n)) {
			path.add(n);
		}
		java.util.Collections.reverse(path);
		return path;
	}

	private record Step<T>(T node, double f) {
	}
}
