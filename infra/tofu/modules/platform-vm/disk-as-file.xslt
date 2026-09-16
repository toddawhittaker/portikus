<?xml version="1.0"?>
<!--
  Rewrite <disk type="volume"> to <disk type="file">.

  The libvirt provider attaches pool volumes as type="volume". On Ubuntu and
  Pop!_OS, libvirt's AppArmor helper (virt-aa-helper) does not resolve pool
  volumes to paths, so the per-VM profile omits the disks and QEMU is denied
  access to them and their backing image. File-type disks are resolved fully.
-->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="xml" indent="yes"/>

  <xsl:template match="@*|node()">
    <xsl:copy><xsl:apply-templates select="@*|node()"/></xsl:copy>
  </xsl:template>

  <xsl:template match="disk[@type='volume']">
    <disk type="file">
      <xsl:apply-templates select="@*[name()!='type']|node()"/>
    </disk>
  </xsl:template>

  <xsl:template match="disk[@type='volume']/source[@pool]">
    <source file="${pool_path}/{@volume}"/>
  </xsl:template>
</xsl:stylesheet>
