import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Auth Redesign - Split-Screen Experience & Design Tokens', () => {
    const htmlPath = path.resolve('DoseBuddy_frontend/index.html');
    const cssPath = path.resolve('DoseBuddy_frontend/style.css');
    const respPath = path.resolve('DoseBuddy_frontend/responsive.css');
    const imgPath = path.resolve('DoseBuddy_frontend/auth-illustration.png');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const resp = fs.readFileSync(respPath, 'utf8');

    it('illustration asset exists in DoseBuddy_frontend', () => {
        assert.ok(fs.existsSync(imgPath), 'auth-illustration.png must exist');
        const stats = fs.statSync(imgPath);
        assert.ok(stats.size > 10000, 'auth-illustration.png must be a valid non-empty image file');
    });

    it('HTML markup contains left brand panel and right authentication panel', () => {
        assert.ok(html.includes('class="auth-page"'), 'auth-page container exists');
        assert.ok(html.includes('class="auth-brand-panel"'), 'auth-brand-panel exists');
        assert.ok(html.includes('class="auth-brand-badge"'), 'auth-brand-badge exists');
        assert.ok(html.includes('Your health routine, made simpler.'), 'Headline exists');
        assert.ok(html.includes('Stay consistent with your medication and take control of your daily health routine.'), 'Description exists');
        assert.ok(html.includes('auth-illustration.png'), 'auth-illustration.png referenced');
        assert.ok(html.includes('Medication reminders · Health tracking · AI assistance'), 'Brand features line exists');

        // Right panel
        assert.ok(html.includes('class="auth-card"'), 'auth-card exists');
        assert.ok(html.includes('data-mode="login"'), 'Login tab exists');
        assert.ok(html.includes('data-mode="signup"'), 'Sign Up tab exists');
        assert.ok(html.includes('Welcome back!'), 'Welcome back heading exists');
        assert.ok(html.includes('Sign in to continue your health journey.'), 'Sign in subtitle exists');
        assert.ok(html.includes('placeholder="Enter your email"'), 'Email placeholder matches design');
        assert.ok(html.includes('placeholder="Enter your password"'), 'Password placeholder matches design');
        assert.ok(html.includes('id="auth-submit-btn"'), 'Submit button exists');
        assert.ok(html.includes('id="forgot-password-btn"'), 'Forgot password link exists');
        assert.ok(html.includes('class="auth-disclaimer"'), 'Medical disclaimer exists');
    });

    it('Preserves all functional authentication forms and steps', () => {
        assert.ok(html.includes('id="login-form"'), 'login-form preserved');
        assert.ok(html.includes('id="signup-form"'), 'signup-form preserved');
        assert.ok(html.includes('id="otp-verify-form"'), 'otp-verify-form preserved');
        assert.ok(html.includes('id="forgot-password-form"'), 'forgot-password-form preserved');
        assert.ok(html.includes('id="signup-step-1"'), 'signup step 1 preserved');
        assert.ok(html.includes('id="signup-step-2"'), 'signup step 2 preserved');
        assert.ok(html.includes('id="signup-step-3"'), 'signup step 3 preserved');
        assert.ok(html.includes('id="role-cards"'), 'role cards preserved');
        assert.ok(html.includes('id="gender-cards"'), 'gender cards preserved');
    });

    it('CSS contains desktop split-screen grid layout and brand panel styles', () => {
        assert.match(css, /\.auth-page\s*\{[^}]*display:\s*grid;/i, 'auth-page uses grid layout');
        assert.match(css, /\.auth-brand-panel\s*\{[^}]*background:\s*#087f78;/i, 'auth-brand-panel uses deep teal #087f78');
        assert.ok(css.includes('.auth-illustration-card'), 'auth-illustration-card styled');
        assert.ok(css.includes('.auth-brand-headline'), 'auth-brand-headline styled');
    });

    it('CSS eliminates pale-blue inputs and overrides browser autofill', () => {
        assert.ok(css.includes('background: #eae2d7 !important;'), 'Inputs use warm beige/cream #eae2d7 surface');
        assert.ok(css.includes('border: 1.5px solid #ded6c9 !important;'), 'Inputs use subtle warm border #ded6c9');
        assert.ok(css.includes('-webkit-autofill'), 'Autofill override defined');
        assert.ok(css.includes('0 0 0 1000px #eae2d7 inset !important'), 'Autofill background locked to warm beige');
    });

    it('Responsive CSS provides single-column mobile layout and hides illustration', () => {
        assert.ok(resp.includes('@media (max-width: 960px)'), 'Mobile 960px breakpoint exists');
        assert.ok(resp.includes('grid-template-columns: 1fr !important'), 'Mobile converts to single column');
        assert.ok(resp.includes('.auth-brand-illustration-wrap'), 'Illustration wrap handled in responsive');
        assert.ok(resp.includes('display: none !important'), 'Illustration hidden on mobile screens');
        assert.ok(resp.includes('@media (max-width: 480px)'), '480px mobile breakpoint exists');
        assert.ok(resp.includes('@media (max-width: 360px)'), '360px small mobile breakpoint exists');
    });
});
