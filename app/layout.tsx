import type { ReactNode } from 'react';
import { Newsreader, Public_Sans } from 'next/font/google';
import './globals.css';

const sans = Public_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const serif = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500'],
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
