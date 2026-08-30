import { isPlatformBrowser } from '@angular/common';
import { Component, computed, Inject, input, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ApiClient, User } from '../core/api-client';

@Component({
  selector: 'app-nav',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <header class="nav">
      <a class="brand" routerLink="/intent" aria-label="Nextwave home"><span class="brand-mark"></span><span>nextwave</span></a>
      <nav aria-label="Primary navigation">
        <a routerLink="/agent" routerLinkActive="active">Agent</a>
        <a routerLink="/intent" routerLinkActive="active">Intent</a>
        <a routerLink="/mandates" routerLinkActive="active">Mandates</a>
        <a routerLink="/activity" routerLinkActive="active">Activity</a>
      </nav>
      <a class="account" routerLink="/auth"><span>{{ initials() }}</span><b>{{ displayName() }}</b></a>
    </header>
  `,
  styles: [`
    .nav {
      position: relative;
      z-index: 30;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      height: 76px;
      padding: 0 32px;
      border-bottom: 1px solid var(--line);
      background: rgba(247, 250, 253, .72);
      backdrop-filter: blur(22px) saturate(130%);
    }
    nav { display: flex; gap: 5px; padding: 5px; border: 1px solid rgba(255,255,255,.62); border-radius: 999px; background: rgba(224,231,240,.72); box-shadow: inset 0 1px 0 rgba(255,255,255,.72); }
    nav a { position: relative; border-radius: 999px; padding: 10px 17px; color: #526077; text-decoration: none; font-size: 13px; font-weight: 650; transition: color 180ms ease, background 180ms ease, transform 180ms ease; }
    nav a:hover { color: var(--ink); transform: translateY(-1px); }
    nav a.active { color: var(--ink); background: white; box-shadow: 0 4px 12px rgba(29,49,80,.08); }
    .account { justify-self: end; display: flex; align-items: center; gap: 9px; border-radius: 999px; text-decoration: none; font-size: 13px; }
    .account span { display: grid; place-items: center; width: 34px; height: 34px; color: white; border: 1px solid rgba(255,255,255,.35); border-radius: 50%; background: linear-gradient(145deg, #263f6e, #799ce7); font-size: 11px; box-shadow: 0 7px 18px rgba(36,63,111,.18); }
    @media (max-width: 800px) {
      .nav {
        position: sticky;
        top: 0;
        grid-template-columns: 1fr auto;
        grid-template-rows: 62px 48px;
        height: 111px;
        padding: max(env(safe-area-inset-top), 0px) 16px 0;
        background: rgba(247,250,253,.92);
        box-shadow: 0 10px 30px rgba(22,46,79,.06);
      }
      nav {
        grid-column: 1 / -1;
        grid-row: 2;
        align-self: start;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        width: 100%;
        padding: 4px;
      }
      .brand { grid-column: 1; grid-row: 1; }
      .account { grid-column: 2; grid-row: 1; }
      nav a { min-width: 0; padding: 9px 5px; text-align: center; font-size: 11px; }
      .account b { display: none; }
    }
  `],
})
export class AppNav implements OnInit {
  readonly userName = input('');
  readonly user = signal<User | null>(null);
  readonly displayName = computed(() => this.userName() || this.user()?.displayName || 'Marta');
  readonly initials = computed(() => this.displayName().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase());

  constructor(private readonly api: ApiClient, @Inject(PLATFORM_ID) private readonly platformId: object) {}
  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.api.getMe().subscribe({ next: ({ user }) => this.user.set(user), error: () => undefined });
  }
}
