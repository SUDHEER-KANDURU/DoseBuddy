import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Auth Cream Theme Unification', () => {
    const responsiveCss = fs.readFileSync(path.resolve('DoseBuddy_frontend/responsive.css'), 'utf8');
    const styleCss = fs.readFileSync(path.resolve('DoseBuddy_frontend/style.css'), 'utf8');
    const indexHtml = fs.readFileSync(path.resolve('DoseBuddy_frontend/index.html'), 'utf8');

    it('responsive.css eliminates white and cool-gray overrides on #auth-view and .auth-card', () => {
        // Find Part 5 in responsive.css
        const part5Idx = responsiveCss.indexOf('PART 5: Auth screens always cream theme guard');
        assert.ok(part5Idx !== -1, 'Part 5 guard should exist in responsive.css');
        const part5Block = responsiveCss.slice(part5Idx, responsiveCss.indexOf('/* ── PRX MODAL mobile', part5Idx));

        // Must not contain #f8f9fb or #ffffff overrides
        assert.ok(!part5Block.includes('#f8f9fb'), 'Part 5 should not reference cool-gray #f8f9fb');
        assert.ok(!part5Block.includes('#ffffff'), 'Part 5 should not set background to pure white #ffffff');

        // Must use cream variables and tokens
        assert.ok(part5Block.includes('#E4DDD3'), 'Part 5 must set --bg / background to cream #E4DDD3');
        assert.ok(part5Block.includes('#f5f1ec'), 'Part 5 must set --surface / card background to cream surface #f5f1ec');
        assert.ok(part5Block.includes('#cfc8be'), 'Part 5 must set --border to warm border #cfc8be');
        assert.ok(part5Block.includes('#1a1714'), 'Part 5 must set --text-primary to dark warm text #1a1714');
        assert.ok(part5Block.includes('#00A19B'), 'Part 5 must preserve teal accent #00A19B');
    });

    it('style.css enforces unified cream theme variables on #auth-view even in dark mode', () => {
        const authSectionIdx = styleCss.indexOf('THEME ISOLATION: AUTH VIEWS & LOGOUT MODAL ALWAYS LIGHT');
        assert.ok(authSectionIdx !== -1, 'Theme isolation section should exist in style.css');
        const authSection = styleCss.slice(authSectionIdx, styleCss.indexOf('/* Dark-mode aware logout modal', authSectionIdx));

        // Checks for #auth-view and body.dark-mode #auth-view
        assert.ok(authSection.includes('body.dark-mode #auth-view'), 'Dark mode must explicitly enforce cream theme on auth view');
        assert.ok(authSection.includes('--bg:             #E4DDD3 !important;'), '--bg must be #E4DDD3');
        assert.ok(authSection.includes('--surface:        #f5f1ec !important;'), '--surface must be #f5f1ec');
        assert.ok(authSection.includes('--border:         #cfc8be !important;'), '--border must be #cfc8be');
        assert.ok(authSection.includes('background: #E4DDD3 !important;'), 'Background must be #E4DDD3');

        // Inputs, role-cards, gender-cards, terms
        assert.ok(authSection.includes('#auth-view input:not([type="checkbox"]):not([type="radio"])'), 'Inputs must be styled cream');
        assert.ok(authSection.includes('#auth-view .role-card'), 'Role cards must use cream theme');
        assert.ok(authSection.includes('#auth-view .gender-card'), 'Gender cards must use cream theme');
        assert.ok(authSection.includes('#auth-view .terms-section'), 'Terms section must use cream theme');
    });

    it('index.html inline headers in auth-view do not use hardcoded cool slate colors', () => {
        const authViewMatch = indexHtml.match(/<section id="auth-view"[\s\S]*?<\/section>/);
        assert.ok(authViewMatch, '#auth-view section must exist in index.html');
        const authViewHtml = authViewMatch[0];

        // Ensure neither slate #1e293b nor #64748b are present
        assert.ok(!authViewHtml.includes('#1e293b'), 'OTP / Reset Password headers must not use #1e293b');
        assert.ok(!authViewHtml.includes('#64748b'), 'OTP / Reset Password subtitles must not use #64748b');

        // Ensure CSS variables are used
        assert.ok(authViewHtml.includes('var(--text-primary)'), 'Headers should use var(--text-primary)');
        assert.ok(authViewHtml.includes('var(--text-muted)'), 'Subtitles should use var(--text-muted)');
    });

    it('contrast ratio between primary dark text and cream backgrounds meets WCAG AA', () => {
        // Luminance calculation helper
        function sRGBtoLin(colorVal: number): number {
            colorVal = colorVal / 255;
            return colorVal <= 0.04045 ? colorVal / 12.92 : Math.pow((colorVal + 0.055) / 1.055, 2.4);
        }
        function getLuminance(hex: string): number {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
        }
        function getContrastRatio(hex1: string, hex2: string): number {
            const l1 = getLuminance(hex1);
            const l2 = getLuminance(hex2);
            const brighter = Math.max(l1, l2);
            const darker = Math.min(l1, l2);
            return (brighter + 0.05) / (darker + 0.05);
        }

        const textColor = '#1a1714';
        const bgCream = '#E4DDD3';
        const surfaceCream = '#f5f1ec';

        const contrastWithBg = getContrastRatio(textColor, bgCream);
        const contrastWithSurface = getContrastRatio(textColor, surfaceCream);

        // WCAG AA requires at least 4.5:1 for normal text
        assert.ok(contrastWithBg >= 4.5, `Contrast with --bg should be >= 4.5, got ${contrastWithBg}`);
        assert.ok(contrastWithSurface >= 4.5, `Contrast with --surface should be >= 4.5, got ${contrastWithSurface}`);
    });
});
