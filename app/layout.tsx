import type { ReactNode } from 'react';
import { Instrument_Sans, Newsreader } from 'next/font/google';
import './globals.css';

const sans = Instrument_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

// Newsreader is used for one thing only: the wait figure, which is the number
// the whole page exists to show.
const serif = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400'],
  variable: '--font-serif',
});

export const metadata = {
  title: 'WaitWise — compare NHS waiting times near you',
  description:
    'Compare how long hospitals near you are taking to treat patients, so you can use your right to choose where you are referred.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" className={`${sans.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
