'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { db, SpeakerMapping } from '@/lib/db';
import { Edit, Save, X, User } from 'lucide-react';

interface Utterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface SpeakerEditorProps {
  transcriptId: string;
  utterances: Utterance[];
  onMappingsUpdate?: () => void;
}

export function SpeakerEditor({ transcriptId, utterances, onMappingsUpdate }: SpeakerEditorProps) {
  const [speakerMappings, setSpeakerMappings] = useState<SpeakerMapping['speakerLabels']>([]);
  const [editingMapping, setEditingMapping] = useState<{
    originalSpeaker: string;
    customName: string;
    isSkipped: boolean;
  } | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Get unique speakers from utterances
  const uniqueSpeakers = Array.from(new Set(utterances.map(u => u.speaker))).sort();

  // Load existing speaker mappings from IndexedDB
  useEffect(() => {
    const loadMappings = async () => {
      try {
        const existing = await db.getSpeakerMappings(transcriptId);
        if (existing) {
          setSpeakerMappings(existing.speakerLabels);
        } else {
          // Initialize with default mappings for all speakers
          const defaultMappings = uniqueSpeakers.map(speaker => ({
            originalSpeaker: speaker,
            customName: '',
            isSkipped: false,
          }));
          setSpeakerMappings(defaultMappings);
        }
      } catch (error) {
        console.error('Error loading speaker mappings:', error);
        // Initialize with default mappings on error
        const defaultMappings = uniqueSpeakers.map(speaker => ({
          originalSpeaker: speaker,
          customName: '',
          isSkipped: false,
        }));
        setSpeakerMappings(defaultMappings);
      }
    };

    loadMappings();
  }, [transcriptId, uniqueSpeakers]);

  // Save speaker mappings to IndexedDB
  const saveMappings = async () => {
    try {
      setSaving(true);
      await db.saveSpeakerMappings(transcriptId, speakerMappings);
    } catch (error) {
      console.error('Error saving speaker mappings:', error);
      alert('Failed to save speaker mappings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Handle editing a speaker mapping
  const handleEditSpeaker = (originalSpeaker: string) => {
    const existing = speakerMappings.find(m => m.originalSpeaker === originalSpeaker);
    setEditingMapping(existing || {
      originalSpeaker,
      customName: '',
      isSkipped: false,
    });
    setIsDialogOpen(true);
  };

  // Handle saving edited speaker mapping
  const handleSaveMapping = async () => {
    if (!editingMapping) return;

    const updatedMappings = speakerMappings.map(mapping =>
      mapping.originalSpeaker === editingMapping.originalSpeaker
        ? editingMapping
        : mapping
    );

    // If this is a new mapping, add it
    if (!speakerMappings.find(m => m.originalSpeaker === editingMapping.originalSpeaker)) {
      updatedMappings.push(editingMapping);
    }

    setSpeakerMappings(updatedMappings);
    setIsDialogOpen(false);
    setEditingMapping(null);
    
    // Auto-save after editing
    try {
      await db.saveSpeakerMappings(transcriptId, updatedMappings);
      // Notify parent component of the update
      if (onMappingsUpdate) {
        onMappingsUpdate();
      }
    } catch (error) {
      console.error('Error auto-saving speaker mappings:', error);
    }
  };

  // Get sample utterances for a speaker
  const getSampleUtterances = (speaker: string, count: number = 3): Utterance[] => {
    return utterances
      .filter(u => u.speaker === speaker)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start)) // Sort by length, longest first
      .slice(0, count);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Speaker Labels
          </CardTitle>
          <Button
            onClick={saveMappings}
            disabled={saving}
            variant="outline"
            size="sm"
          >
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save All'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Customize speaker names for better transcript readability. Changes are saved locally and will be applied when generating transcripts.
          </p>
          
          <div className="grid gap-4">
            {uniqueSpeakers.map(speaker => {
              const mapping = speakerMappings.find(m => m.originalSpeaker === speaker);
              const sampleUtterances = getSampleUtterances(speaker, 2);
              
              return (
                <div key={speaker} className="border rounded-lg p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{speaker}</Badge>
                      {mapping?.customName && (
                        <>
                          <span className="text-muted-foreground">→</span>
                          <Badge variant="default">{mapping.customName}</Badge>
                        </>
                      )}
                      {mapping?.isSkipped && (
                        <Badge variant="secondary">Skipped</Badge>
                      )}
                    </div>
                    <Dialog open={isDialogOpen && editingMapping?.originalSpeaker === speaker} onOpenChange={setIsDialogOpen}>
                      <DialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditSpeaker(speaker)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Edit Speaker: {speaker}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor="customName">Custom Name</Label>
                            <Input
                              id="customName"
                              placeholder="Enter custom name (optional)"
                              value={editingMapping?.customName || ''}
                              onChange={(e) => setEditingMapping(prev => prev ? {
                                ...prev,
                                customName: e.target.value
                              } : null)}
                            />
                          </div>
                          <div className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              id="isSkipped"
                              checked={editingMapping?.isSkipped || false}
                              onChange={(e) => setEditingMapping(prev => prev ? {
                                ...prev,
                                isSkipped: e.target.checked
                              } : null)}
                            />
                            <Label htmlFor="isSkipped">Skip this speaker (will be marked as skipped)</Label>
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              onClick={() => {
                                setIsDialogOpen(false);
                                setEditingMapping(null);
                              }}
                            >
                              <X className="h-4 w-4 mr-2" />
                              Cancel
                            </Button>
                            <Button onClick={handleSaveMapping}>
                              <Save className="h-4 w-4 mr-2" />
                              Save
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                  
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Sample utterances:</p>
                    {sampleUtterances.map((utterance, index) => (
                      <div key={index} className="text-sm text-muted-foreground bg-muted p-2 rounded">
                        &quot;{utterance.text}&quot;
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
} 