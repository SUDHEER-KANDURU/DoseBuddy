package com.example.dosebuddy.security;

import com.example.dosebuddy.model.User;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import java.util.Collection;
import java.util.List;

/**
 * Spring Security UserDetails wrapper around the DoseBuddy User entity.
 */
public class UserPrincipal implements UserDetails {

    private final User user;

    public UserPrincipal(User user) {
        this.user = user;
    }

    // ── Custom accessors ────────────────────────────────────────────────────

    public Long getUserId() {
        return user.getId();
    }

    public String getRole() {
        return user.getRole();
    }

    public User getUser() {
        return user;
    }

    // ── UserDetails ─────────────────────────────────────────────────────────

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        String role = user.getRole() != null ? user.getRole() : "PATIENT";
        return List.of(new SimpleGrantedAuthority("ROLE_" + role));
    }

    @Override
    public String getPassword() {
        return user.getPasswordHash();
    }

    /** Email is the principal identifier. */
    @Override
    public String getUsername() {
        return user.getEmail();
    }

    @Override public boolean isAccountNonExpired()     { return true; }
    @Override public boolean isAccountNonLocked()      { return true; }
    @Override public boolean isCredentialsNonExpired() { return true; }
    @Override public boolean isEnabled()               { return true; }
}
