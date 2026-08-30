import { Component, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { ApiClient } from '../../core/api-client';

@Component({
  selector: 'app-auth-page',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './auth-page.html',
  styleUrl: './auth-page.css',
})
export class AuthPage {
  readonly mode = signal<'login' | 'register'>('login');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly form = new FormGroup({
    displayName: new FormControl('Marta Pérez', { nonNullable: true }),
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(12)] }),
  });

  constructor(private readonly api: ApiClient, private readonly router: Router) {}

  setMode(mode: 'login' | 'register'): void { this.mode.set(mode); this.error.set(''); }

  submit(): void {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    const { displayName, email, password } = this.form.getRawValue();
    this.busy.set(true); this.error.set('');
    const request = this.mode() === 'login' ? this.api.login(email, password) : this.api.register(displayName, email, password);
    request.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => void this.router.navigateByUrl('/intent'),
      error: (error: Error) => this.error.set(error.message),
    });
  }
}
