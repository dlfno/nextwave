import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-nav',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <header class="nav">
      <a class="brand" routerLink="/intent" aria-label="Nextwave home"><span class="brand-mark"></span><span>nextwave</span></a>
      <nav aria-label="Primary navigation">
        <a routerLink="/agent" routerLinkActive="active">Agent</a>
        <a routerLink="/intent" routerLinkActive="active">Intent</a>
        <button type="button" disabled title="Available in the next milestone">Mandates</button>
        <button type="button" disabled title="Available in a later milestone">Activity</button>
      </nav>
      <a class="account" routerLink="/auth"><span>MP</span><b>{{ userName() }}</b></a>
    </header>
  `,
  styles: [`
    .nav { height: 76px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 32px; border-bottom: 1px solid var(--line); }
    nav { display: flex; gap: 5px; padding: 5px; border-radius: 999px; background: rgba(224,231,240,.72); }
    nav a, nav button { border: 0; border-radius: 999px; padding: 10px 17px; color: #526077; background: transparent; text-decoration: none; font-size: 13px; font-weight: 650; }
    nav a.active { color: var(--ink); background: white; box-shadow: 0 4px 12px rgba(29,49,80,.08); }
    nav button:disabled { opacity: .48; cursor: default; }
    .account { justify-self: end; display: flex; align-items: center; gap: 9px; text-decoration: none; font-size: 13px; }
    .account span { display: grid; place-items: center; width: 34px; height: 34px; color: white; border-radius: 50%; background: linear-gradient(145deg, #263f6e, #799ce7); font-size: 11px; }
    @media (max-width: 800px) { .nav { grid-template-columns: 1fr auto; height: 68px; padding: 0 18px; } nav { position: fixed; z-index: 20; left: 50%; bottom: 14px; transform: translateX(-50%); box-shadow: 0 12px 36px rgba(7,16,31,.18); } nav button { display: none; } .account b { display: none; } }
  `],
})
export class AppNav { readonly userName = input('Marta'); }
