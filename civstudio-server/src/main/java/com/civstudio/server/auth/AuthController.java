package com.civstudio.server.auth;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.web.authentication.RememberMeServices;
import org.springframework.security.web.authentication.logout.LogoutHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;

/**
 * Provider-agnostic auth endpoints (see {@code docs/authentication.md}): who am I, sign out, and
 * which sign-in providers this server offers — so the browser renders only the buttons that work.
 * The per-provider sign-in flows live in their own controllers ({@link SteamAuthController}) or in
 * Spring Security ({@code /oauth2/authorization/{provider}} for OIDC).
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

	private final UserStore users;
	private final ObjectProvider<ClientRegistrationRepository> clientRegistrations;
	private final ObjectProvider<RememberMeServices> rememberMe;

	public AuthController(UserStore users,
			ObjectProvider<ClientRegistrationRepository> clientRegistrations,
			ObjectProvider<RememberMeServices> rememberMe) {
		this.users = users;
		this.clientRegistrations = clientRegistrations;
		this.rememberMe = rememberMe;
	}

	/**
	 * The current authenticated user, or {@code {authenticated:false}}.
	 *
	 * <p>Carries {@code admin} as well as identity: a client cannot work out from an id alone
	 * whether the operator controls (restart the demo, and whatever joins it) belong on screen, and
	 * probing a gated endpoint to find out means showing a button that may 403. This is a hint for
	 * PAINTING only — every admin action is still checked server-side on the request that performs
	 * it, so forging the flag client-side buys nothing.
	 */
	@GetMapping("/me")
	public Map<String, Object> me() {
		Authentication auth = SecurityContextHolder.getContext().getAuthentication();
		if (auth == null || !auth.isAuthenticated() || auth instanceof AnonymousAuthenticationToken)
			return Map.of("authenticated", false);
		boolean admin = auth.getAuthorities().stream()
				.anyMatch(a -> Admins.ROLE_ADMIN.equals(a.getAuthority()));
		return users.findById(auth.getName())
				.map(u -> Map.<String, Object>of("authenticated", true, "id", u.id(), "provider",
						u.provider(), "displayName", u.displayName(),
						"avatarUrl", u.avatarUrl() == null ? "" : u.avatarUrl(),
						"admin", admin))
				.orElse(Map.of("authenticated", false));
	}

	/**
	 * Sign out: invalidate the session, expire the remember-me cookie, and clear the security
	 * context. Expiring {@code civstudio-remember} is essential — with {@code alwaysRemember} the
	 * next {@code /api/auth/me} would otherwise re-authenticate from that cookie and the UI would
	 * flip straight back to signed-in (see {@code docs/authentication.md}). The remember-me service
	 * is present only when a key is configured (prod); a no-op otherwise.
	 */
	@PostMapping("/logout")
	public ResponseEntity<Void> logout(HttpServletRequest request, HttpServletResponse response) {
		Authentication auth = SecurityContextHolder.getContext().getAuthentication();
		// the remember-me service is also a LogoutHandler whose logout() cancels the cookie with
		// the exact name/path/secure it was set with
		if (rememberMe.getIfAvailable() instanceof LogoutHandler lh)
			lh.logout(request, response, auth);
		HttpSession session = request.getSession(false);
		if (session != null)
			session.invalidate();
		SecurityContextHolder.clearContext();
		return ResponseEntity.noContent().build();
	}

	/**
	 * The sign-in providers this server offers. Steam is always present (the default); OIDC
	 * providers appear only when configured (their {@code ClientRegistration} exists) — so the UI
	 * never shows a button for an endpoint that would 404.
	 */
	@GetMapping("/providers")
	public Map<String, Object> providers() {
		List<String> providers = new ArrayList<>();
		providers.add(AppUser.STEAM);
		ClientRegistrationRepository repo = clientRegistrations.getIfAvailable();
		if (repo != null && repo.findByRegistrationId("google") != null)
			providers.add("google");
		return Map.of("providers", providers);
	}
}
