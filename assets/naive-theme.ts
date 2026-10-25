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
    tableHeaderColor: '#F1F5F9',
    inputColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    dividerColor: '#E2E8F0',
    hoverColor: '#F1F5F9',
    tableColorHover: '#F1F5F9',
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
    borderRadius: '14px',
  },
  Menu: {
    itemBorderRadius: '8px',
  },
};
