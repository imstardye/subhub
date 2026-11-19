// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Naive UI theme overrides — the component-library side of the design tokens.
 *
 * The palette mirrors `assets/css/main.css` (light only): trust blue #2563EB,
 * page #F8FAFC, white cards, green #16A34A reserved for success. Keep both in
 * sync when the tokens change; this file is the single place that maps them
 * onto Naive's theme object.
 */
import type { GlobalThemeOverrides } from 'naive-ui';

type ThemePart<K extends keyof GlobalThemeOverrides> = NonNullable<GlobalThemeOverrides[K]>;

/** User-center surfaces and controls, scoped to /my so admin density stays the same. */
export const userCenterCardTheme: ThemePart<'Card'> = {
  borderRadius: 'var(--radius-panel)',
  borderColor: 'var(--border)',
  boxShadow: 'var(--shadow-lg)',
  paddingSmall: '12px 16px 16px',
  paddingMedium: '20px 20px 20px',
  titleFontSizeMedium: '16px',
  titleFontWeight: '700',
};

export const userCenterTargetTheme: ThemePart<'Radio'> = {
  buttonBorderRadius: 'var(--radius-pill)',
  buttonBorderColor: 'transparent',
  buttonBorderColorActive: 'transparent',
  buttonColor: 'transparent',
  buttonColorActive: 'linear-gradient(110deg, var(--primary-hover), #0369a1)',
  buttonTextColor: 'var(--foreground)',
  buttonTextColorActive: 'var(--primary-foreground)',
  buttonTextColorHover: 'var(--primary-hover)',
  buttonBoxShadowHover: 'inset 0 0 0 1px var(--border)',
  buttonBoxShadowFocus: 'inset 0 0 0 2px var(--card), 0 0 0 2px var(--primary)',
};

export const userCenterButtonTheme: ThemePart<'Button'> = {
  colorPressedPrimary: '#1e40af',
  colorSecondaryPressed: '#dbeafe',
  colorOpacitySecondaryPressed: '0.32',
  textColorTextPressed: 'var(--primary-hover)',
};

export const userCenterEmptyTheme: ThemePart<'Empty'> = {
  iconColor: 'var(--primary)',
  textColor: 'var(--muted-foreground)',
};

export const userCenterSkeletonTheme: ThemePart<'Skeleton'> = {
  color: 'var(--accent-soft)',
  colorEnd: 'var(--border)',
};

const FONT_SANS =
  "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const FONT_MONO =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export const naiveThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2563EB',
    primaryColorHover: '#1D4ED8',
    primaryColorPressed: '#1D4ED8',
    primaryColorSuppl: '#2563EB',
    infoColor: '#2563EB',
    infoColorHover: '#1D4ED8',
    infoColorPressed: '#1D4ED8',
    infoColorSuppl: '#2563EB',
    successColor: '#16A34A',
    successColorHover: '#15803D',
    successColorPressed: '#15803D',
    successColorSuppl: '#16A34A',
    warningColor: '#D97706',
    warningColorHover: '#B45309',
    warningColorPressed: '#B45309',
    warningColorSuppl: '#D97706',
    errorColor: '#DC2626',
    errorColorHover: '#B91C1C',
    errorColorPressed: '#B91C1C',
    errorColorSuppl: '#DC2626',
    textColorBase: '#1E293B',
    textColor1: '#1E293B',
    textColor2: '#334155',
    textColor3: '#64748B',
    textColorDisabled: '#94A3B8',
    placeholderColor: '#64748B',
    bodyColor: '#F8FAFC',
    cardColor: '#FFFFFF',
    modalColor: '#FFFFFF',
    popoverColor: '#FFFFFF',
    tableColor: '#FFFFFF',
    /* Naive `common` colours must stay literal hex: seemly computes with
       them (rgba derivation) and throws on var() references at runtime. */
    tableHeaderColor: '#F1F5F9',
    inputColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    dividerColor: '#E2E8F0',
    hoverColor: '#F1F5F9',
    tableColorHover: '#F8FBFF',
    borderRadius: '8px',
    borderRadiusSmall: '4px',
    fontFamily: FONT_SANS,
    fontFamilyMono: FONT_MONO,
    fontSize: '14px',
    fontSizeSmall: '13px',
    fontSizeMini: '12px',
    lineHeight: '1.6',
  },
  Button: {
    borderRadiusMedium: '8px',
    borderRadiusSmall: '6px',
    fontWeight: '500',
    fontWeightStrong: '600',
  },
  Card: {
    borderRadius: '14px',
  },
  Input: {
    borderRadius: '8px',
  },
  Select: {
    peers: {
      InternalSelection: {
        borderRadius: '8px',
      },
    },
  },
  Tag: {
    borderRadius: '999px',
  },
  Progress: {
    railHeight: '6px',
  },
  DataTable: {
    borderRadius: 'var(--radius-lg)',
    thPaddingSmall: '12px 16px',
    tdPaddingSmall: '12px 16px',
    thFontWeight: '600',
  },
  Menu: {
    itemBorderRadius: 'var(--radius)',
    itemColorActive: 'var(--sidebar-active)',
    itemTextColorActive: 'var(--primary)',
    itemIconColorActive: 'var(--primary)',
    itemColorHover: 'var(--hover-surface)',
  },
};
