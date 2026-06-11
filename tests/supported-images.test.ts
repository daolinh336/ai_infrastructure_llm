import { describe, expect, it } from 'vitest';
import {
  canonicalizeImageBase,
  extractCanonicalImageBases,
  isSupportedImageReference,
} from '../src/domain/supported-images.js';

describe('supported image canonicalization', () => {
  it('canonicalizes generic small typos for supported image bases', () => {
    expect(canonicalizeImageBase('ngnix')).toMatchObject({
      value: 'nginx',
      reason: 'typo',
    });
    expect(canonicalizeImageBase('ndoe')).toMatchObject({
      value: 'node',
      reason: 'typo',
    });
    expect(canonicalizeImageBase('pyhton')).toMatchObject({
      value: 'python',
      reason: 'typo',
    });
    expect(canonicalizeImageBase('myql')).toMatchObject({
      value: 'mysql',
      reason: 'typo',
    });
    expect(canonicalizeImageBase('redos')).toMatchObject({
      value: 'redis',
      reason: 'typo',
    });
  });

  it('keeps semantic aliases separate from typo repair', () => {
    expect(canonicalizeImageBase('postgresql')).toMatchObject({
      value: 'postgres',
      reason: 'synonym',
    });
    expect(canonicalizeImageBase('apache')).toMatchObject({
      value: 'httpd',
      reason: 'synonym',
    });
    expect(canonicalizeImageBase('java')).toMatchObject({
      value: 'openjdk',
      reason: 'synonym',
    });
    expect(canonicalizeImageBase('mongodb')).toMatchObject({
      value: 'mongo',
      reason: 'synonym',
    });
  });

  it('does not force distant unsupported image names into the allowlist', () => {
    expect(canonicalizeImageBase('bitnami')).toMatchObject({
      value: 'bitnami',
      reason: 'none',
    });
  });

  it('supports the expanded baseline image catalog but not vendor namespaces alone', () => {
    for (const image of [
      'alpine:3.20',
      'ubuntu:24.04',
      'debian:12',
      'busybox:1.36',
      'nginx:stable',
      'httpd:2.4',
      'traefik:v3.1',
      'redis:7-alpine',
      'postgres:16',
      'mysql:8',
      'mariadb:11',
      'mongo:7',
      'python:3.12-alpine',
      'node:20-alpine',
      'golang:1.23-alpine',
      'openjdk:21',
      'eclipse-temurin:21-jdk',
      'rabbitmq:3-management',
      'docker.elastic.co/elasticsearch/elasticsearch:8.15.0',
      'apache/kafka:3.8.0',
      'quay.io/keycloak/keycloak:26.0',
    ]) {
      expect(isSupportedImageReference(image), image).toBe(true);
    }

    expect(isSupportedImageReference('bitnami')).toBe(false);
  });

  it('extracts canonical image bases from prompt text in prompt order', () => {
    expect(extractCanonicalImageBases('Tao ngnix, pyhton va redos')).toEqual([
      'nginx',
      'python',
      'redis',
    ]);
  });
});
