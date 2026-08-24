/**
 * Icon set. Inline SVG rather than an icon font or dependency: it inherits
 * `currentColor`, scales with text, and adds nothing to the bundle we do not use.
 */
const base = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true, focusable: false,
};

const Icon = ({ children, size = 16, ...rest }) => (
  <svg {...base} width={size} height={size} {...rest}>{children}</svg>
);

export const IconDashboard = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Icon>;
export const IconUsers = (p) => <Icon {...p}><path d="M16 19v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V19" /><circle cx="9" cy="7" r="3.2" /><path d="M22 19v-1.5a4 4 0 0 0-3-3.87" /><path d="M16 4.13a4 4 0 0 1 0 5.74" /></Icon>;
export const IconPhone = (p) => <Icon {...p}><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.5 19.5 0 0 1-8.5-3 19 19 0 0 1-5.9-5.9 19.5 19.5 0 0 1-3-8.6A2 2 0 0 1 4.4 2H7a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a15 15 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7A2 2 0 0 1 22 16.9Z" /></Icon>;
export const IconPhoneIncoming = (p) => <Icon {...p}><path d="M16 2v6h6" /><path d="M22 2l-7 7" /><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.5 19.5 0 0 1-8.5-3 19 19 0 0 1-5.9-5.9 19.5 19.5 0 0 1-3-8.6A2 2 0 0 1 4.4 2H7a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a15 15 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7A2 2 0 0 1 22 16.9Z" /></Icon>;
export const IconPipeline = (p) => <Icon {...p}><path d="M3 6h18" /><path d="M6 12h12" /><path d="M9 18h6" /></Icon>;
export const IconSparkles = (p) => <Icon {...p}><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></Icon>;
export const IconMessage = (p) => <Icon {...p}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-3.7-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /></Icon>;
export const IconMail = (p) => <Icon {...p}><rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><path d="m3 7 9 6 9-6" /></Icon>;
export const IconCheck = (p) => <Icon {...p}><path d="m4 12.5 5 5L20 6.5" /></Icon>;
export const IconCheckCircle = (p) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5" /></Icon>;
export const IconX = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const IconPlus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const IconSearch = (p) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
export const IconBell = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 6-3 7-3 7h18s-3-1-3-7" /><path d="M13.7 20a2 2 0 0 1-3.4 0" /></Icon>;
export const IconCalendar = (p) => <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></Icon>;
export const IconTask = (p) => <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1.5 1.5L7 5" /><path d="m3 12 1.5 1.5L7 11" /><path d="m3 18 1.5 1.5L7 17" /></Icon>;
export const IconChart = (p) => <Icon {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Icon>;
export const IconSettings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.9-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Icon>;
export const IconShield = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></Icon>;
export const IconTrend = (p) => <Icon {...p}><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></Icon>;
export const IconTrendDown = (p) => <Icon {...p}><path d="m3 7 6 6 4-4 8 8" /><path d="M15 17h6v-6" /></Icon>;
export const IconAlert = (p) => <Icon {...p}><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 9v5M12 17.5v.5" /></Icon>;
export const IconClock = (p) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></Icon>;
export const IconNote = (p) => <Icon {...p}><path d="M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9l-6-6Z" /><path d="M14 3v6h6" /></Icon>;
export const IconMic = (p) => <Icon {...p}><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" /></Icon>;
export const IconMicOff = (p) => <Icon {...p}><path d="M3 3l18 18" /><path d="M9 9v3a3 3 0 0 0 4.6 2.5" /><path d="M15 10.5V5.5a3 3 0 0 0-5.8-1" /><path d="M5.5 11a6.5 6.5 0 0 0 10 5.5" /><path d="M12 17.5V21" /></Icon>;
export const IconPause = (p) => <Icon {...p}><rect x="7" y="5" width="3.5" height="14" rx="1" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" /></Icon>;
export const IconTransfer = (p) => <Icon {...p}><path d="M17 3l4 4-4 4" /><path d="M21 7H8a4 4 0 0 0-4 4v1" /><path d="M7 21l-4-4 4-4" /><path d="M3 17h13a4 4 0 0 0 4-4v-1" /></Icon>;
export const IconHangup = (p) => <Icon {...p}><path d="M2 8.5a20 20 0 0 1 20 0v3.2a1.6 1.6 0 0 1-1.7 1.6l-2.6-.2a1.6 1.6 0 0 1-1.4-1.3l-.3-1.6a13 13 0 0 0-8 0l-.3 1.6a1.6 1.6 0 0 1-1.4 1.3l-2.6.2A1.6 1.6 0 0 1 2 11.7Z" /><path d="m19 17-2 4" /><path d="m5 17 2 4" /></Icon>;
export const IconChevronRight = (p) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>;
export const IconChevronDown = (p) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const IconChevronLeft = (p) => <Icon {...p}><path d="m15 6-6 6 6 6" /></Icon>;
export const IconMenu = (p) => <Icon {...p}><path d="M3 6h18M3 12h18M3 18h18" /></Icon>;
export const IconMoon = (p) => <Icon {...p}><path d="M21 13a8.5 8.5 0 1 1-10-10 7 7 0 0 0 10 10Z" /></Icon>;
export const IconSun = (p) => <Icon {...p}><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></Icon>;
export const IconLogout = (p) => <Icon {...p}><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></Icon>;
export const IconUpload = (p) => <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7.5 9.5 4.5-4.5 4.5 4.5" /><path d="M12 5v11" /></Icon>;
export const IconDownload = (p) => <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7.5 11.5 4.5 4.5 4.5-4.5" /><path d="M12 16V4" /></Icon>;
export const IconFilter = (p) => <Icon {...p}><path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" /></Icon>;
export const IconBuilding = (p) => <Icon {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" /></Icon>;
export const IconTarget = (p) => <Icon {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></Icon>;
export const IconLightning = (p) => <Icon {...p}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></Icon>;
export const IconBookOpen = (p) => <Icon {...p}><path d="M2 4.5h6a4 4 0 0 1 4 4V21a3 3 0 0 0-3-3H2Z" /><path d="M22 4.5h-6a4 4 0 0 0-4 4V21a3 3 0 0 1 3-3h7Z" /></Icon>;
export const IconExternal = (p) => <Icon {...p}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></Icon>;
export const IconRefresh = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></Icon>;
export const IconEdit = (p) => <Icon {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const IconTrash = (p) => <Icon {...p}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" /><path d="M10 11v6M14 11v6" /></Icon>;
export const IconLink = (p) => <Icon {...p}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></Icon>;
export const IconKey = (p) => <Icon {...p}><circle cx="8" cy="15" r="4.5" /><path d="m11 12 8-8" /><path d="m17 4 3 3-2 2-3-3Z" /></Icon>;
export const IconFile = (p) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></Icon>;
export const IconGrid = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>;
export const IconInbox = (p) => <Icon {...p}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 4.5h13l3.5 7.5v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z" /></Icon>;
export const IconStar = (p) => <Icon {...p}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9Z" /></Icon>;
export const IconThumb = (p) => <Icon {...p}><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" /><path d="M7 10 11 3a2 2 0 0 1 2.8 1.8V9h4.6a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17 20H7" /></Icon>;
export const IconPlay = (p) => <Icon {...p}><path d="M7 4.5v15l13-7.5Z" /></Icon>;
export const IconWave = (p) => <Icon {...p}><path d="M3 12h2M8 6v12M12 3v18M16 8v8M20 11v2" /></Icon>;
export const IconRobot = (p) => <Icon {...p}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4" /><circle cx="9" cy="14" r="1.2" /><circle cx="15" cy="14" r="1.2" /><path d="M2 13v3M22 13v3" /></Icon>;

export default {};
