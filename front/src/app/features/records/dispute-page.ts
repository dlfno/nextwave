import { DatePipe, JsonPipe, isPlatformBrowser } from '@angular/common';
import { Component, Inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiClient, DisputeRecord } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';
import { demoDispute } from './record-demo';

interface DisputeEvidence { bundle:Record<string,unknown>;bundleHash:string;verificationResult:{valid:boolean;eventCount:number} }
@Component({selector:'app-dispute-page',imports:[AppNav,RouterLink,DatePipe,JsonPipe],templateUrl:'./dispute-page.html',styleUrl:'./dispute-page.css'})
export class DisputePage implements OnInit{
  readonly id:string;readonly dispute=signal<DisputeRecord|null>(null);readonly evidence=signal<DisputeEvidence|null>(null);readonly demo=signal(false);readonly loading=signal(true);readonly error=signal('');
  constructor(route:ActivatedRoute,private readonly api:ApiClient,@Inject(PLATFORM_ID) private readonly platformId:object){this.id=route.snapshot.paramMap.get('disputeId')??'demo-dispute'}
  ngOnInit():void{if(this.id==='demo-dispute'||!isPlatformBrowser(this.platformId)){this.useDemo();return}this.api.getDispute(this.id).subscribe({next:({dispute,evidence})=>{this.dispute.set(dispute);this.evidence.set(evidence);this.loading.set(false)},error:(error:Error)=>{this.error.set(error.message);this.loading.set(false)}})}
  label(value:string):string{return value.toLowerCase().replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase())}
  private useDemo():void{const data=demoDispute();this.dispute.set(data.dispute);this.evidence.set(data.evidence);this.demo.set(true);this.loading.set(false)}
}
